/**
 * Letting only so many jobs run at once.
 *
 * This box serves another business's customers as well as ours. Two
 * LibreOffice processes is what the plan allows; the limit is not a
 * performance tuning knob, it is the thing that keeps a Utilade traffic spike
 * from becoming somebody else's outage.
 *
 * Waiting is bounded as well. An unbounded queue does not protect anyone — it
 * accepts a thousand uploads and then times out all thousand, having held a
 * thousand files in memory on the way. Past the limit we refuse immediately,
 * which is a better answer and an honest one.
 */

export function createQueue({ concurrency = 2, maxWaiting = 8 } = {}) {
  let running = 0;
  const waiting = [];

  const pump = () => {
    while (running < concurrency && waiting.length > 0) {
      const next = waiting.shift();
      running += 1;
      next.start();
    }
  };

  return {
    get running() {
      return running;
    },
    get waiting() {
      return waiting.length;
    },
    /** True when another job would have to be turned away. */
    get full() {
      return running >= concurrency && waiting.length >= maxWaiting;
    },

    /**
     * Run `job` when there is room.
     *
     * Rejects immediately when the queue is full, so the caller can answer 503
     * before reading an upload it is only going to discard.
     */
    run(job) {
      if (running >= concurrency && waiting.length >= maxWaiting) {
        const error = new Error(
          "The converter is busy. Please try again in a moment.",
        );
        error.status = 503;
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        const entry = {
          start: () => {
            Promise.resolve()
              .then(job)
              .then(resolve, reject)
              .finally(() => {
                running -= 1;
                pump();
              });
          },
        };

        waiting.push(entry);
        pump();
      });
    },
  };
}
