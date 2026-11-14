/** 审批决定仅在服务端确认后生效；批准不等于工具执行完成。 */
export function approvalPresentation(block) {
  const decided = !!block.decided;
  const busy = !!block.submitting && !decided;
  const state = decided ? block.allowed === true ? 'allowed' : block.allowed === false ? 'denied' : 'resolved' : busy ? 'submitting' : 'pending';
  const labels = { allowed: '已允许执行', denied: '已拒绝', resolved: '已处理', submitting: '提交中…', pending: '待审批' };
  return { state, decided, busy, label: labels[state], open: block.expanded ?? !decided, error: block.decisionError || '' };
}
export async function decideApproval(block, allow, submit) {
  if (block.decided || block.submitting || typeof allow !== 'boolean') return false;
  block.submitting = true;
  block.decisionError = '';
  try {
    const receipt = await submit(allow);
    if (receipt?.decided !== true) throw new Error("审批已失效或已处理，请核对当前任务状态。");
    block.decided = true;
    block.allowed = allow;
    block.expanded = false;
    block.payloadOpen = false;
    return true;
  } catch (error) {
    block.decisionError = '提交失败：' + (error?.message || String(error));
    block.expanded = true;
    return false;
  } finally {
    block.submitting = false;
  }
}
