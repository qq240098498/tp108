const crypto = require('crypto');
const { load, save, FILE_TYPES, MAX_PATH_LENGTH, MAX_CONTENT_LENGTH, MAX_NOTE_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');

// 路径只允许字母数字、点、下划线、短横线与斜线，后缀必须是认得的几种
const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const KNOWN_EXTENSIONS = ['js', 'sh', 'md', 'yml'];

function extensionOf(filePath) {
  if (!filePath.includes('.')) return '';
  return filePath.split('.').pop().toLowerCase();
}

function validatePath(value, data, selfId) {
  const filePath = pickText(value);
  if (!filePath) throw new ApiError(400, 'PATH_REQUIRED', '请填写文件路径', 'filePath');
  if (filePath.length > MAX_PATH_LENGTH) {
    throw new ApiError(400, 'PATH_TOO_LONG', `文件路径不能超过 ${MAX_PATH_LENGTH} 个字符`, 'filePath');
  }
  if (!PATH_PATTERN.test(filePath) || filePath.startsWith('/') || filePath.includes('..')) {
    throw new ApiError(400, 'PATH_INVALID', '文件路径只能用字母数字、点、下划线、短横线与斜线，且不能用相对上级的写法', 'filePath');
  }
  const ext = extensionOf(filePath);
  if (!KNOWN_EXTENSIONS.includes(ext)) {
    throw new ApiError(400, 'PATH_EXTENSION_INVALID', `只收录 ${KNOWN_EXTENSIONS.join('、')} 这几种文件`, 'filePath');
  }
  const hit = data.files.find((item) => item.id !== selfId && item.path.toLowerCase() === filePath.toLowerCase());
  if (hit) throw new ApiError(409, 'PATH_DUPLICATED', `路径 ${hit.path} 已经收录过了`, 'filePath');
  return filePath;
}

function validateContent(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'CONTENT_INVALID', '文件内容需要是文本', 'content');
  if (!value.trim()) throw new ApiError(400, 'CONTENT_REQUIRED', '文件内容不能为空', 'content');
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new ApiError(400, 'CONTENT_TOO_LONG', `文件内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`, 'content');
  }
  return value;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

function lineCountOf(content) {
  if (!content) return 0;
  return content.split('\n').length;
}

// 说明文字里常见的句读标点，脚本与配置里基本不会出现
const PROSE_PUNCT = /[。，、；：！？]/;

// 行数翻到这个倍数并且多出的绝对行数也够多，才认为贴进来的内容多得离谱
const LINE_JUMP_RATIO = 3;
const LINE_JUMP_MIN_EXTRA = 20;

function commentPrefixesOf(type) {
  if (type === 'js') return ['//', '/*', '*', '*/'];
  return ['#'];
}

// 数一下内容里有多少行像说明文字：先去掉注释行与空行，再看剩下的行有没有中文句读标点
function proseLineCount(content, type) {
  const prefixes = commentPrefixesOf(type);
  const lines = content.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !prefixes.some((prefix) => line.startsWith(prefix)));
  const prose = lines.filter((line) => PROSE_PUNCT.test(line));
  return { total: lines.length, prose: prose.length };
}

// 收录前的成组校验：把路径、后缀、内容与明显贴错的地方一次都查一遍。
// 只把问题列出来，不改任何数据；响应完全由输入与当前数据决定，跑多少次结论都一样
function checkFile(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const selfId = pickText(input.id);
  const errors = [];
  const warnings = [];

  let filePath = '';
  try {
    filePath = validatePath(input.path, data, selfId);
  } catch (err) {
    errors.push({ code: err.code, message: err.message, field: err.field });
  }

  let content = '';
  try {
    content = validateContent(input.content);
  } catch (err) {
    errors.push({ code: err.code, message: err.message, field: err.field });
  }

  if (filePath && content) {
    const type = extensionOf(filePath);
    // 文档本来就写说明文字，脚本与配置里成片出现句读标点才可疑
    if (type !== 'md') {
      const stat = proseLineCount(content, type);
      if (stat.prose >= 2 && stat.prose * 5 >= stat.total * 2) {
        warnings.push({
          code: 'CONTENT_LOOKS_PROSE',
          message: `内容里有 ${stat.prose} 行像说明文字（有效内容共 ${stat.total} 行），可能把整段说明当成脚本贴进来了`,
          field: 'content',
        });
      }
    }
    const existing = selfId ? data.files.find((item) => item.id === selfId) : null;
    if (existing) {
      const before = lineCountOf(existing.content);
      const after = lineCountOf(content);
      if (after > before * LINE_JUMP_RATIO && after - before >= LINE_JUMP_MIN_EXTRA) {
        warnings.push({
          code: 'CONTENT_LINES_JUMPED',
          message: `原来 ${before} 行，现在 ${after} 行，一下子多出太多，可能把别的内容一起贴进来了`,
          field: 'content',
        });
      }
    }
  }

  return { errors, warnings };
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
  const filePath = validatePath(input.path, data, '');
  const content = validateContent(input.content);
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    path: filePath,
    type: extensionOf(filePath),
    content,
    note: validateNote(input.note),
    createdAt: now,
    updatedAt: now,
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

  found.path = input.path === undefined ? found.path : validatePath(input.path, data, found.id);
  found.type = extensionOf(found.path);
  found.content = input.content === undefined ? found.content : validateContent(input.content);
  found.note = input.note === undefined ? found.note : validateNote(input.note);
  found.updatedAt = new Date().toISOString();
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
  checkFile,
  lineCountOf,
};
