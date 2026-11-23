/**
 * 定时任务存储选择器：请求内按当前登录用户走 PostgreSQL；
 * 执行器遍历所有账号的到期任务，并在执行时切到任务所属用户。
 */
import { createPgScheduleStore } from "./pg-schedules.mjs";
import { lastOccurrence } from "./schedules.mjs";
import { currentUserId } from "./request-context.mjs";

export function createScheduleRouter({ store = null, fileStore, userId = currentUserId, now = () => new Date() }) {
  if (!fileStore) throw new TypeError("createScheduleRouter 需要文件定时任务存储");
  const owners = new Map();

  function adapterFor(id) {
    return createPgScheduleStore({ repos: store.repos, userId: id, now });
  }

  function withUser(fn) {
    const id = typeof userId === "function" ? userId() : userId;
    return store && id ? fn(adapterFor(id)) : fn(fileStore);
  }

  async function allUserTasks() {
    const users = await store.repos.users.listAll();
    const tasks = [];
    for (const user of users) {
      for (const task of await adapterFor(user.id).list()) {
        owners.set(task.id, user.id);
        tasks.push({ ...task, userId: user.id });
      }
    }
    return tasks;
  }

  return {
    list: () => withUser(target => target.list()),
    get: id => withUser(target => target.get(id)),
    create: input => withUser(target => target.create(input)),
    update: (id, patch) => withUser(target => target.update(id, patch)),
    remove: id => withUser(target => target.remove(id)),
    finish: (id, payload) => (store && owners.has(id) ? adapterFor(owners.get(id)).finish(id, payload) : fileStore.finish(id, payload)),
    /** 执行器用：所有账号里到期的任务；没有数据库时退回文件存储。 */
    async dueForRunner() {
      if (!store) return fileStore.due();
      const at = now();
      const tasks = await allUserTasks();
      return tasks.filter(task => {
        if (task.enabled === false) return false;
        const occurrence = lastOccurrence(task, at);
        if (occurrence === null) return false;
        const since = task.lastRunAt ? Date.parse(task.lastRunAt) : Date.parse(task.createdAt || 0);
        return occurrence > since;
      });
    },
  };
}