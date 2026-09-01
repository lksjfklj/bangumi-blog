// src/sanitize.js - 富文本/HTML 白名单净化（防 XSS）
// 用法：对 markdown-it 等渲染产物在返回前端前统一过一遍
const sanitizeHtml = require('sanitize-html');

const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img',
  'ul', 'ol', 'li',
  'blockquote',
  'code', 'pre',
  'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'span', 'div',
  'details', 'summary'
];

const ALLOWED_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
  code: ['class'],
  pre: ['class'],
  span: ['class'],
  table: ['class'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan']
};

function sanitizeHtmlSafe(html) {
  return sanitizeHtml(String(html == null ? '' : html), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,   // 禁止 //evil.com 这类协议相对链接
    disallowedTagsMode: 'discard', // script/style/iframe 等直接丢弃（连内容一起）
    transformTags: {
      a: (tagName, attribs) => {
        const out = { ...attribs };
        delete out.target; // 只允许当前页打开；若真要新窗口也强制 noopener
        if (out.rel) out.rel = 'noopener noreferrer';
        return { tagName: 'a', attribs: out };
      }
    }
  });
}

module.exports = { sanitizeHtmlSafe };
