#include "threadpool.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

struct ThreadPool {
    pthread_t *threads; int workers, started;
    void **queue; int cap, head, count;
    TpJob fn;
    pthread_mutex_t lock; pthread_cond_t wake;
    int shutting_down, joined;
    atomic_int busy, queued;
};

typedef struct { ThreadPool *pool; int id; } WorkerArg;

/* One worker: take a job under the lock, run it outside the lock, repeat. */
static void *worker_main(void *p) {
    WorkerArg a = *(WorkerArg *)p; ThreadPool *pool = a.pool;
    free(p);
    pthread_mutex_lock(&pool->lock);
    for (;;) {
        while (pool->count == 0 && !pool->shutting_down) pthread_cond_wait(&pool->wake, &pool->lock);
        if (pool->count == 0) break;
        void *arg = pool->queue[pool->head];
        pool->head = (pool->head + 1) % pool->cap;
        pool->count--;
        atomic_store(&pool->queued, pool->count);
        atomic_fetch_add(&pool->busy, 1);
        pthread_mutex_unlock(&pool->lock);
        pool->fn(arg, a.id);
        pthread_mutex_lock(&pool->lock);
        atomic_fetch_sub(&pool->busy, 1);
    }
    pthread_mutex_unlock(&pool->lock);
    return NULL;
}

ThreadPool *tp_create(int workers, int queue_cap, TpJob fn) {
    if (workers <= 0 || queue_cap <= 0 || !fn) return NULL;
    ThreadPool *pool = calloc(1, sizeof *pool);
    if (!pool) return NULL;
    pool->threads = calloc((size_t)workers, sizeof *pool->threads);
    pool->queue = calloc((size_t)queue_cap, sizeof *pool->queue);
    pool->workers = workers; pool->cap = queue_cap; pool->fn = fn;
    if (!pool->threads || !pool->queue || pthread_mutex_init(&pool->lock, NULL)) goto fail_mem;
    if (pthread_cond_init(&pool->wake, NULL)) { pthread_mutex_destroy(&pool->lock); goto fail_mem; }
    for (int i = 0; i < workers; i++) {
        WorkerArg *a = malloc(sizeof *a);
        if (!a) break;
        *a = (WorkerArg){pool, i};
        if (pthread_create(&pool->threads[i], NULL, worker_main, a)) { free(a); break; }
        pool->started++;
    }
    if (pool->started != workers) { tp_destroy(pool); return NULL; }
    return pool;
fail_mem:
    free(pool->threads); free(pool->queue); free(pool);
    return NULL;
}

int tp_submit(ThreadPool *pool, void *arg) {
    int rc = -1;
    if (!pool) return -1;
    pthread_mutex_lock(&pool->lock);
    if (!pool->shutting_down && pool->count < pool->cap) {
        pool->queue[(pool->head + pool->count) % pool->cap] = arg;
        pool->count++;
        atomic_store(&pool->queued, pool->count);
        rc = 0;
        pthread_cond_signal(&pool->wake);
    }
    pthread_mutex_unlock(&pool->lock);
    return rc;
}

void tp_shutdown(ThreadPool *pool) {
    if (!pool) return;
    pthread_mutex_lock(&pool->lock);
    pool->shutting_down = 1;
    int join_now = !pool->joined;
    pool->joined = 1;
    pthread_cond_broadcast(&pool->wake);
    pthread_mutex_unlock(&pool->lock);
    if (!join_now) return;
    for (int i = 0; i < pool->started; i++) pthread_join(pool->threads[i], NULL);
}

void tp_destroy(ThreadPool *pool) {
    if (!pool) return;
    tp_shutdown(pool);
    pthread_cond_destroy(&pool->wake);
    pthread_mutex_destroy(&pool->lock);
    free(pool->threads); free(pool->queue); free(pool);
}

int tp_busy(const ThreadPool *pool) { return pool ? atomic_load(&pool->busy) : 0; }
int tp_queued(const ThreadPool *pool) { return pool ? atomic_load(&pool->queued) : 0; }
