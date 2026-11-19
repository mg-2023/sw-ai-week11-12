#ifndef MINI_DBMS_THREADPOOL_H
#define MINI_DBMS_THREADPOOL_H

typedef void (*TpJob)(void *arg, int worker_id);
typedef struct ThreadPool ThreadPool;

/* Fixed workers and a fixed-size ring queue. NULL on bad arguments or failure. */
ThreadPool *tp_create(int workers, int queue_cap, TpJob fn);
/* 0 = queued, -1 = queue full or shut down. Never blocks. */
int tp_submit(ThreadPool *pool, void *arg);
/* Reject new jobs, run the jobs already queued, join all workers. Idempotent. */
void tp_shutdown(ThreadPool *pool);
/* Shut down if still running, then free the pool. */
void tp_destroy(ThreadPool *pool);
/* Workers running a job now / jobs waiting in the queue. Safe from any thread. */
int tp_busy(const ThreadPool *pool);
int tp_queued(const ThreadPool *pool);

#endif
