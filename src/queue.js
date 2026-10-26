/**
 * 排队：同一个人/群内串行（避免上下文交错），全局限制并发（避免同时起一堆 dsh 进程）。
 */

export class KeyedQueue {
  /**
   * @param {{globalConcurrency?: number, perKeyConcurrency?: number, log?: any}} options
   */
  constructor({ globalConcurrency = 2, perKeyConcurrency = 1, log } = {}) {
    this.globalConcurrency = globalConcurrency;
    this.perKeyConcurrency = perKeyConcurrency;
    this.log = log;
    this.active = 0;
    this.activeByKey = new Map();
    /** @type {Array<{key: string, run: () => Promise<any>, resolve: Function, reject: Function}>} */
    this.pending = [];
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  push(key, run) {
    return new Promise((resolve, reject) => {
      this.pending.push({ key, run, resolve, reject });
      this.#drain();
    });
  }

  stats() {
    return {
      active: this.active,
      waiting: this.pending.length,
      byKey: Object.fromEntries(this.activeByKey),
    };
  }

  #drain() {
    while (this.active < this.globalConcurrency) {
      const index = this.pending.findIndex(
        (job) => (this.activeByKey.get(job.key) ?? 0) < this.perKeyConcurrency,
      );
      if (index === -1) return;
      const [job] = this.pending.splice(index, 1);
      this.active += 1;
      this.activeByKey.set(job.key, (this.activeByKey.get(job.key) ?? 0) + 1);

      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          const count = (this.activeByKey.get(job.key) ?? 1) - 1;
          if (count <= 0) this.activeByKey.delete(job.key);
          else this.activeByKey.set(job.key, count);
          this.#drain();
        });
    }
  }
}
