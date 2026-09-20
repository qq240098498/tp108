const crypto = require('crypto');
const { load, save, FILE_TYPES, MAX_PATH_LENGTH, MAX_CONTENT_LENGTH, MAX_NOTE_LENGTH } = require('./store');
const { ApiError, pickText, validationError } = require('./errors');

// 路径只允许字母数字、点、下划线、短横线与斜线，后缀必须是认得的几种
const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const KNOWN_EXTENSIONS = ['js', 'sh', 'md', 'yml'];

// 行数暴涨的认定：比原文件多出至少这么多行，并且翻到几倍开外，才算「多得离谱」
const LINE_JUMP_RATIO = 3;
const LINE_JUMP_MIN = 20;

// 说明文字的特征：带中文句读标点，或者一长段连续中文里一个代码符号都没有
const PROSE_PUNCTUATION = /[。；，、？！]/;
const CODE_MARK = /[=;{}()$#\\/]/;
const COMMENT_START = /^(\/\/|#|\/\*|\*)/;
const CJK_RUN = /[一-鿿]/g;

function extensionOf(filePath) {
  if (!filePath.includes('.')) return '';
  return filePath.split('.').pop().toLowerCase();
}

function lineCountOf(content) {
  if (!content) return 0;
  return content.split('\n').length;
}

// 整段说明文字当成脚本贴进来的识别：把空行与注释行剔掉之后，
// 像说明文字的行占到一半以上（且至少两行），这份内容就不像是脚本了
function isProseLine(line) {
  if (PROSE_PUNCTUATION.test(line)) return true;
  const cjk = line.match(CJK_RUN);
  return Boolean(cjk) && cjk.length >= 12 && !CODE_MARK.test(line);
}

function looksLikeProse(content) {
  const lines = content.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !COMMENT_START.test(line));
  if (lines.length < 2) return false;
  const prose = lines.filter(isProseLine).length;
  return prose >= 2 && prose / lines.length >= 0.5;
}

// 成组校验：路径、内容、备注各查各的，问题全部收集起来一次报出，
// 而不是遇到第一个就停；同一字段内部仍然先拦下再说，不往下硬查
function validateFilePayload(input, data, current) {
  const problems = [];
  const values = {};
  const isCreate = !current;
  const selfId = current ? current.id : '';

  if (isCreate || input.path !== undefined) {
    const filePath = pickText(input.path);
    if (!filePath) {
      problems.push({ status: 400, code: 'PATH_REQUIRED', message: '请填写文件路径', field: 'filePath' });
    } else if (filePath.length > MAX_PATH_LENGTH) {
      problems.push({ status: 400, code: 'PATH_TOO_LONG', message: `文件路径不能超过 ${MAX_PATH_LENGTH} 个字符`, field: 'filePath' });
    } else if (!PATH_PATTERN.test(filePath) || filePath.startsWith('/') || filePath.includes('..')) {
      problems.push({ status: 400, code: 'PATH_INVALID', message: '文件路径只能用字母数字、点、下划线、短横线与斜线，且不能用相对上级的写法', field: 'filePath' });
    } else if (!KNOWN_EXTENSIONS.includes(extensionOf(filePath))) {
      problems.push({ status: 400, code: 'PATH_EXTENSION_INVALID', message: `只收录 ${KNOWN_EXTENSIONS.join('、')} 这几种文件`, field: 'filePath' });
    } else {
      const hit = data.files.find((item) => item.id !== selfId && item.path.toLowerCase() === filePath.toLowerCase());
      if (hit) {
        problems.push({ status: 409, code: 'PATH_DUPLICATED', message: `路径 ${hit.path} 已经收录过了`, field: 'filePath' });
      } else {
        values.path = filePath;
      }
    }
  }

  if (isCreate || input.content !== undefined) {
    const content = input.content;
    if (typeof content !== 'string') {
      problems.push({ status: 400, code: 'CONTENT_INVALID', message: '文件内容需要是文本', field: 'content' });
    } else if (!content.trim()) {
      problems.push({ status: 400, code: 'CONTENT_REQUIRED', message: '文件内容不能为空', field: 'content' });
    } else if (content.length > MAX_CONTENT_LENGTH) {
      problems.push({ status: 400, code: 'CONTENT_TOO_LONG', message: `文件内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`, field: 'content' });
    } else {
      values.content = content;
      // 明显贴错的两类检查，要在内容本身过关之后才有意义
      const type = extensionOf(values.path !== undefined ? values.path : (current ? current.path : ''));
      if ((type === 'js' || type === 'sh') && looksLikeProse(content)) {
        problems.push({ status: 400, code: 'CONTENT_LOOKS_PROSE', message: '内容里大段都是说明文字，不像是脚本，可能把说明当成文件内容贴进来了', field: 'content' });
      }
      if (current) {
        const before = lineCountOf(current.content);
        const after = lineCountOf(content);
        if (before > 0 && after > before * LINE_JUMP_RATIO && after - before >= LINE_JUMP_MIN) {
          problems.push({ status: 400, code: 'CONTENT_LINE_JUMP', message: `内容从 ${before} 行一下变成 ${after} 行，比原文件多得多，可能把别的东西一起贴进来了`, field: 'content' });
        }
      }
    }
  }

  if (input.note === undefined) {
    if (isCreate) values.note = '';
  } else if (input.note === null) {
    values.note = '';
  } else if (typeof input.note !== 'string') {
    problems.push({ status: 400, code: 'NOTE_INVALID', message: '备注需要是文本', field: 'fileNote' });
  } else if (input.note.length > MAX_NOTE_LENGTH) {
    problems.push({ status: 400, code: 'NOTE_TOO_LONG', message: `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, field: 'fileNote' });
  } else {
    values.note = input.note.trim();
  }

  return { problems, values };
}

function withMeta(file) {
  return { ...file, lineCount: lineCountOf(file.content) };
}

function sortFiles(list) {
  return list.slice().sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 文件清单：按类型筛选，再按路径或备注搜索
function listFiles(options) {
  const input = options && typeof options === 'object' ? options : {};
  const type = pickText(input.type);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.files;
  if (type) list = list.filter((item) => item.type === type);
  if (keyword) {
    list = list.filter((item) => item.path.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword));
  }

  return {
    files: sortFiles(list).map(withMeta),
    fileTypes: FILE_TYPES.filter((item) => item !== '全部'),
  };
}

function getFile(id) {
  const data = load();
  const found = data.files.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'FILE_NOT_FOUND', '这个文件不存在或已被移出清单', '');
  return withMeta(found);
}

function createFile(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const { problems, values } = validateFilePayload(input, data, null);
  if (problems.length) throw validationError(problems);
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    path: values.path,
    type: extensionOf(values.path),
    content: values.content,
    note: values.note !== undefined ? values.note : '',
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
  };
  data.files.push(created);
  save(data);
  return withMeta(created);
}

function updateFile(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.files.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'FILE_NOT_FOUND', '这个文件不存在或已被移出清单', '');
  const { problems, values } = validateFilePayload(input, data, found);
  if (problems.length) throw validationError(problems);

  const now = new Date().toISOString();
  const nextPath = values.path !== undefined ? values.path : found.path;
  const nextContent = values.content !== undefined ? values.content : found.content;
  // 只有路径或内容真的变了，内容的改动时刻才往前走；单改备注不算内容改动
  if (nextPath !== found.path || nextContent !== found.content) {
    found.contentUpdatedAt = now;
  }
  found.path = nextPath;
  found.type = extensionOf(nextPath);
  found.content = nextContent;
  found.note = values.note !== undefined ? values.note : found.note;
  found.updatedAt = now;
  save(data);
  return withMeta(found);
}

function deleteFile(id) {
  const data = load();
  const index = data.files.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'FILE_NOT_FOUND', '这个文件不存在或已被移出清单', '');
  const [removed] = data.files.splice(index, 1);
  save(data);
  return { id: removed.id, path: removed.path };
}

module.exports = {
  listFiles,
  getFile,
  createFile,
  updateFile,
  deleteFile,
  lineCountOf,
  looksLikeProse,
  validateFilePayload,
};
