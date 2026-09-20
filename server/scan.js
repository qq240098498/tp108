const { load, save, LEVELS, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          hits.push({
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  // 扫成了才记扫描记录：范围内的文件各自记下这一轮被扫到的时刻，
  // 已经移出清单的文件顺手从记录里清掉；扫描前检查只靠这份记录出结论
  const scannedAt = new Date().toISOString();
  const currentIds = new Set(data.files.map((item) => item.id));
  filesInScope.forEach((file) => { data.meta.fileScannedAt[file.id] = scannedAt; });
  Object.keys(data.meta.fileScannedAt).forEach((id) => {
    if (!currentIds.has(id)) delete data.meta.fileScannedAt[id];
  });
  data.meta.lastScanAt = scannedAt;
  save(data);

  return {
    scannedAt,
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    summary: {
      total: hits.length,
      byLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
    },
  };
}

// 扫描前检查：只读不写，同样的数据跑多少次结论都一样。
// 范围与扫描一致（指定 fileId 就只看那一个文件），把范围里刚收录还没扫过的、
// 以及上次扫描之后内容被改过的文件分别列出来，并说明这一轮与上一轮是否可比
function precheck(options) {
  const input = options && typeof options === 'object' ? options : {};
  const fileId = pickText(input.fileId);
  const data = load();

  let filesInScope = data.files;
  if (fileId) {
    const scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
    filesInScope = [scopeFile];
  }

  const scanned = data.meta.fileScannedAt || {};
  const hasBaseline = Object.keys(scanned).length > 0;

  const newFiles = [];
  const modifiedFiles = [];
  if (hasBaseline) {
    filesInScope.forEach((file) => {
      const at = scanned[file.id];
      if (!at) {
        newFiles.push({ id: file.id, path: file.path, at: file.createdAt });
      } else if (file.contentUpdatedAt > at) {
        modifiedFiles.push({ id: file.id, path: file.path, at: file.contentUpdatedAt });
      }
    });
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : 1);
  newFiles.sort(byPath);
  modifiedFiles.sort(byPath);

  const comparable = hasBaseline && newFiles.length === 0 && modifiedFiles.length === 0;
  let notice;
  if (!hasBaseline) {
    notice = '还没有任何一轮扫描记录，这一轮将作为第一轮，不存在与上一轮比较的问题';
  } else if (!comparable) {
    notice = `范围里有 ${newFiles.length} 个文件刚收录还没扫过、${modifiedFiles.length} 个文件在上次扫描后内容有改动，这一轮的命中与上一轮不可比`;
  } else {
    notice = '范围里的文件自上次扫描以来都没有变化，这一轮的命中可以与上一轮直接比较';
  }

  return {
    lastScanAt: data.meta.lastScanAt,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    newCount: newFiles.length,
    modifiedCount: modifiedFiles.length,
    comparable,
    notice,
    newFiles,
    modifiedFiles,
  };
}

module.exports = { scan, precheck, ruleAppliesToFile, levelOrder };
