// owner.test.js - 站长身份判定（草稿预览 / 管理接口的凭据判断）
// 背景：只读访客会话（POST /api/auth/viewer）任何人都能自助领取，它只是个"按站长视角只读浏览"
// 的视角，不能当身份凭据——否则谁都能拿一份 is_owner=1 的会话去读站长没发布的草稿。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isOwnerUser } = require('../src/auth');

test('isOwnerUser: 站长真实登录会话为真', () => {
  assert.equal(isOwnerUser({ is_owner: 1, kind: 'user' }), true);
  assert.equal(isOwnerUser({ is_owner: '1', kind: 'user' }), true, 'sqlite 主键可能返回字符串');
  assert.equal(isOwnerUser({ is_owner: 1, kind: undefined }), true, '老会话没带 kind 时按普通会话处理');
});

test('isOwnerUser: 只读访客会话不算站长身份', () => {
  assert.equal(isOwnerUser({ is_owner: 1, kind: 'viewer' }), false);
});

test('isOwnerUser: 普通用户 / 未登录 / 脏数据为假', () => {
  assert.equal(isOwnerUser({ is_owner: 0, kind: 'user' }), false);
  assert.equal(isOwnerUser({ is_owner: '0', kind: 'user' }), false);
  assert.equal(isOwnerUser({ kind: 'user' }), false);
  assert.equal(isOwnerUser({ is_owner: true, kind: 'user' }), true);
  assert.equal(isOwnerUser(null), false);
  assert.equal(isOwnerUser(undefined), false);
  assert.equal(isOwnerUser({}), false);
});
