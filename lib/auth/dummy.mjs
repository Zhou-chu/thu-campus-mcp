/**
 * 登录失败时的“空密码哈希”：账号不存在也照样跑一次 scrypt，
 * 让“邮箱是否已注册”不能靠响应时间判断。这个哈希不对应任何密码。
 */
export const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function dummyPasswordHash() {
  return DUMMY_PASSWORD_HASH;
}
