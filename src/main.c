#include "cli.h"
#include "server.h"

#include <string.h>

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "serve") == 0) return server_main(argc, argv);
    return cli_main(argc, argv);
}
