'use strict';

// Only background producers belong here. Requests and startup are drained by
// the HTTP/server lifecycle before its final Redis flush and database close.
function createBackgroundTasks(timers = globalThis) {
    let stopping = false;
    const scheduled = new Set();
    const active = new Set();

    // Accepted HTTP handlers may already have started detached work when stop
    // closes producer admission. Track that promise without starting new work.
    function track(work) {
        const promise = Promise.resolve(work);
        active.add(promise);
        const finished = () => active.delete(promise);
        promise.then(finished, finished);
        return promise;
    }
    function run(task) {
        if (stopping) return Promise.resolve();
        return track(Promise.resolve().then(task));
    }
    function cancel(handle) {
        timers.clearTimeout(handle);
        timers.clearInterval(handle);
        scheduled.delete(handle);
    }
    function schedule(task, delay, repeat) {
        if (stopping) return null;
        let busy = false;
        const handle = timers[repeat ? 'setInterval' : 'setTimeout'](() => {
            if (!repeat) scheduled.delete(handle);
            if (busy) return;
            busy = true;
            run(task).catch(error => console.error('Background task failed:', error.message))
                .finally(() => { busy = false; });
        }, delay);
        scheduled.add(handle);
        handle.unref?.();
        return handle;
    }
    async function wait() {
        const results = [];
        while (active.size) results.push(...await Promise.allSettled([...active]));
        return results;
    }
    function stop() {
        stopping = true;
        for (const handle of scheduled) cancel(handle);
        return wait();
    }
    return {
        run, track, cancel, stop, wait,
        interval: (task, delay) => schedule(task, delay, true),
        timeout: (task, delay) => schedule(task, delay, false),
        get stopping() { return stopping; },
    };
}

module.exports = createBackgroundTasks();
module.exports.createBackgroundTasks = createBackgroundTasks;
