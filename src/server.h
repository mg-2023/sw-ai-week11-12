#ifndef MINI_DBMS_SERVER_H
#define MINI_DBMS_SERVER_H

/* `mini-dbms serve [--port 8100] [--threads 4] [--queue 64] [--data DIR] [--sync always|none]`.
 * argv[1] is "serve". Listens on 127.0.0.1 only. Runs until Ctrl+C (Ctrl+Break, SIGINT,
 * SIGTERM); then stops accepting, finishes queued requests and closes the database.
 * Returns 0 after a clean stop, 1 on a usage or startup error. */
int server_main(int argc, char **argv);

#endif
