// What a subverted tool would try on macOS to read another process: its arguments and environment, the process table,
// and its path, each by the call itself and through no setuid program; and the named shared memory and semaphores the
// profile no longer grants. Prints one JSON object.
// usage: process-probe <pid> <marker>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <semaphore.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
	if (argc != 3) return 2;
	int pid = atoi(argv[1]);
	const char *marker = argv[2];
	size_t size = 1 << 20;
	char *block = malloc(size);
	int arguments[3] = {CTL_KERN, KERN_PROCARGS2, pid};
	int read = sysctl(arguments, 3, block, &size, NULL, 0) == 0;
	int found = read && memmem(block, size, marker, strlen(marker)) != NULL;
	int table[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
	size_t all = 0;
	int listed = sysctl(table, 3, NULL, &all, NULL, 0) == 0 && all > 0;
	int one[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
	size_t entry = 0;
	int described = sysctl(one, 4, NULL, &entry, NULL, 0) == 0 && entry > 0;
	char path[PROC_PIDPATHINFO_MAXSIZE];
	int located = proc_pidpath(pid, path, sizeof path) > 0;
	int pids[8192];
	int count = proc_listallpids(pids, sizeof pids);
	int own = proc_pidpath(getpid(), path, sizeof path) > 0;
	int cpus = 0;
	size_t width = sizeof cpus;
	int hardware = sysctlbyname("hw.ncpu", &cpus, &width, NULL, 0) == 0 && cpus > 0;
	char value[256];
	size_t length = sizeof value;
	int session = sysctlbyname("kern.bootsessionuuid", value, &length, NULL, 0) == 0;
	// Shared memory and semaphores by name, which any process of the user's can open too.
	char name[64];
	snprintf(name, sizeof name, "/melian-probe-%d", getpid());
	int memory = shm_open(name, O_CREAT | O_RDWR, 0600);
	if (memory >= 0) shm_unlink(name);
	sem_t *semaphore = sem_open(name, O_CREAT, 0600, 1);
	if (semaphore != SEM_FAILED) sem_unlink(name);
	printf("{\"shm\":%d,\"semaphore\":%d,", memory >= 0, semaphore != SEM_FAILED);
	printf("\"arguments\":%d,\"marker\":%d,\"table\":%d,\"entry\":%d,\"path\":%d,\"pids\":%d,\"ownPath\":%d,\"hardware\":%d,\"session\":%d}\n",
		read, found, listed, described, located, count > 0 ? count : 0, own, hardware, session);
	return 0;
}
