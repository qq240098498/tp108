// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
// 成组校验出问题时会再带上 problems 清单，页面据此逐条列出
class ApiError extends Error {
  constructor(status, code, message, field, problems) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
    if (Array.isArray(problems) && problems.length) this.problems = problems;
  }
}

// 去掉首尾空白后的文本，非字符串一律当作空
function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 成组校验的出口：只有一个问题时保持原来的单错形状，多个问题合成一条带清单的错误
function validationError(problems) {
  const list = Array.isArray(problems) ? problems.filter(Boolean) : [];
  if (list.length === 1) {
    const only = list[0];
    return new ApiError(only.status, only.code, only.message, only.field);
  }
  const first = list[0] || {};
  const detail = list.map((item) => ({ code: item.code, message: item.message, field: item.field || '' }));
  return new ApiError(400, 'VALIDATION_FAILED', `提交的内容有 ${list.length} 处问题，请逐项改掉`, first.field || '', detail);
}

module.exports = { ApiError, pickText, validationError };
