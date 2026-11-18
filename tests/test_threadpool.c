#include "test.h"
#include "os.h"
#include "threadpool.h"
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>

static atomic_long sum;
static atomic_int gate_open, started;

/* Sleep without a platform branch in the test. */
static void sleep_ms(long ms) { struct timespec t = {ms / 1000, (ms % 1000) * 1000000L}; nanosleep(&t, NULL); }
static void add_job(void *arg, int worker_id) { (void)worker_id; atomic_fetch_add(&sum, (long)(intptr_t)arg); }
static void slow_job(void *arg, int worker_id) { (void)arg; (void)worker_id; sleep_ms(100); atomic_fetch_add(&sum, 1); }
static void gated_job(void *arg, int worker_id) {
    (void)arg; (void)worker_id;
    atomic_fetch_add(&started, 1);
    while (!atomic_load(&gate_open)) sleep_ms(1);
    atomic_fetch_add(&sum, 1);
}

static void test_all_jobs_run(void) {
    ThreadPool *p = tp_create(4, 64, add_job); long expect = 0;
    ASSERT(p); atomic_store(&sum, 0);
    for (long i = 1; i <= 10000; i++) {
        while (tp_submit(p, (void *)(intptr_t)i) != 0) sleep_ms(0);
        expect += i;
    }
    tp_shutdown(p);
    ASSERT(atomic_load(&sum) == expect);
    ASSERT(tp_busy(p) == 0 && tp_queued(p) == 0);
    tp_destroy(p);
}
static void test_parallel_workers(void) {
    ThreadPool *p = tp_create(4, 8, slow_job); uint64_t t0, dt;
    ASSERT(p); atomic_store(&sum, 0);
    t0 = os_now_us();
    for (int i = 0; i < 4; i++) ASSERT(tp_submit(p, NULL) == 0);
    tp_shutdown(p);
    dt = os_now_us() - t0;
    ASSERT(atomic_load(&sum) == 4);
    ASSERT(dt < 250000);
    tp_destroy(p);
}
static void test_queue_full_returns_minus1(void) {
    ThreadPool *p = tp_create(1, 2, gated_job);
    ASSERT(p); atomic_store(&sum, 0); atomic_store(&started, 0); atomic_store(&gate_open, 0);
    ASSERT(tp_submit(p, NULL) == 0);
    while (atomic_load(&started) == 0) sleep_ms(1);
    ASSERT(tp_busy(p) == 1 && tp_queued(p) == 0);
    ASSERT(tp_submit(p, NULL) == 0 && tp_submit(p, NULL) == 0);
    ASSERT(tp_queued(p) == 2);
    ASSERT(tp_submit(p, NULL) == -1);
    atomic_store(&gate_open, 1);
    tp_shutdown(p);
    ASSERT(atomic_load(&sum) == 3);
    tp_destroy(p);
}
static void test_shutdown_drains(void) {
    ThreadPool *p = tp_create(1, 64, slow_job);
    ASSERT(p); atomic_store(&sum, 0);
    for (int i = 0; i < 5; i++) ASSERT(tp_submit(p, NULL) == 0);
    tp_shutdown(p);
    ASSERT(atomic_load(&sum) == 5);
    ASSERT(tp_submit(p, NULL) == -1);
    tp_shutdown(p);
    tp_destroy(p);
}
static void test_bad_arguments(void) {
    ASSERT(tp_create(0, 4, add_job) == NULL);
    ASSERT(tp_create(4, 0, add_job) == NULL);
    ASSERT(tp_create(4, 4, NULL) == NULL);
}

int main(void) {
    RUN(test_all_jobs_run); RUN(test_parallel_workers); RUN(test_queue_full_returns_minus1);
    RUN(test_shutdown_drains); RUN(test_bad_arguments);
    return test_finish();
}
