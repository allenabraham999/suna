/*
 * Stands in for the runner's own Node (externals/node*\/bin/node, moved to
 * node.real next to it) when run-job.actions.sh turns on the release
 * redirect (docs/action-cache.md, "Release downloads from JavaScript
 * actions"). It starts node.real with `--require <PRELOAD>` and the config
 * path in VULCAN_RELEASE_REDIRECT_CONFIG, and the arguments as given.
 *
 * Plain node.real, with nothing added, when:
 *   - VULCAN_RELEASE_REDIRECT=0 is in the environment (a step's env: turns it off),
 *   - the preload or the config is not there: a container job, where the
 *     runner mounts externals into the container but not /opt or /etc.
 *
 * A program and not a script: a shell would drop the environment variables
 * whose names are not shell names (the runner passes action inputs as
 * INPUT_<NAME>, e.g. INPUT_NO-CACHE), and a container may have no shell at
 * all. Built static in the template, so it runs in any container too.
 */
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef PRELOAD
#define PRELOAD "/opt/vulcan/release-redirect.cjs"
#endif
#ifndef CONFIG
#define CONFIG "/etc/vulcan/release-redirect.json"
#endif

int main(int argc, char **argv) {
  char self[PATH_MAX];
  ssize_t n = -1;
  /* The runner starts it by absolute path; /proc as a fallback. */
  if (argc > 0 && argv[0] && strchr(argv[0], '/') && strlen(argv[0]) < sizeof self - 6) {
    strcpy(self, argv[0]);
    n = (ssize_t)strlen(self);
  } else {
    n = readlink("/proc/self/exe", self, sizeof self - 6);
  }
  if (n <= 0) {
    fputs("node wrapper: cannot find node.real\n", stderr);
    return 127;
  }
  self[n] = '\0';
  strcat(self, ".real");

  char **args = calloc((size_t)argc + 3, sizeof *args);
  if (!args) return 127;
  int j = 0;
  args[j++] = argc > 0 ? argv[0] : self;
  const char *off = getenv("VULCAN_RELEASE_REDIRECT");
  if (!(off && strcmp(off, "0") == 0) && access(PRELOAD, R_OK) == 0 && access(CONFIG, R_OK) == 0) {
    setenv("VULCAN_RELEASE_REDIRECT_CONFIG", CONFIG, 1);
    args[j++] = "--require";
    args[j++] = PRELOAD;
  }
  for (int i = 1; i < argc; i++) args[j++] = argv[i];
  args[j] = NULL;
  execv(self, args);
  perror("node wrapper: node.real");
  return 127;
}
