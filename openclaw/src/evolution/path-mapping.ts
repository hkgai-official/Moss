// src/evolution/path-mapping.ts
//
// Path translation between container-internal paths and host-absolute paths.
// The host daemon (running on the docker host) only understands host paths;
// the evolution module (running inside the container) sees container paths.
// Every path crossing the RPC boundary must go through `pathToHost()`.

// Env vars are read at call time (not import time) so test fixtures can set
// them in beforeAll() without losing the binding. In production these are set
// by docker-compose at container start and never change.
const CONTAINER_DATA_PREFIX = "/home/node/.openclaw";
const CONTAINER_REPO_PREFIX = "/app";
const CONTAINER_BENCHMARK_PREFIX = "/benchmark";

export function pathToHost(containerPath: string): string {
  const hostDataDir = process.env.MOSS_DATA_DIR;
  const hostRepoDir = process.env.MOSS_OPENCLAW_REPO_DIR;
  if (!hostDataDir || !hostRepoDir) {
    throw new Error(
      "MOSS_DATA_DIR and MOSS_OPENCLAW_REPO_DIR must be set in container env",
    );
  }
  if (containerPath.startsWith(CONTAINER_DATA_PREFIX)) {
    return hostDataDir + containerPath.slice(CONTAINER_DATA_PREFIX.length);
  }
  if (containerPath.startsWith(CONTAINER_REPO_PREFIX)) {
    return hostRepoDir + containerPath.slice(CONTAINER_REPO_PREFIX.length);
  }
  if (containerPath.startsWith(CONTAINER_BENCHMARK_PREFIX)) {
    // benchmark/ is mounted into the container at /benchmark (read-only) but
    // lives at <moss-root>/benchmark on host. Derive host abs by
    // replacing /benchmark with HOST_REPO_DIR/../benchmark.
    const evoclawRoot = hostRepoDir.replace(/\/openclaw\/?$/, "");
    return evoclawRoot + containerPath;
  }
  // Already an absolute host path? leave alone (caller asserts).
  if (containerPath.startsWith("/")) {
    return containerPath;
  }
  // Treat plain relative paths as "relative to moss repo root" (the
  // legacy contract for inputManifestPath, etc.). Resolve to host abs.
  const evoclawRoot = hostRepoDir.replace(/\/openclaw\/?$/, "");
  return `${evoclawRoot}/${containerPath}`;
}

/** Reverse of `pathToHost()`. Translates a host-absolute path into its
 *  container-visible equivalent. Needed when the host daemon returns a path
 *  (e.g. a grade-summary file written into the iter dir) that the
 *  in-container framework then wants to `fs.readFileSync` directly. Returns
 *  the input untouched if no known mount prefix matches — caller decides
 *  whether that should be treated as an error. */
export function pathToContainer(hostPath: string): string {
  const hostDataDir = process.env.MOSS_DATA_DIR;
  const hostRepoDir = process.env.MOSS_OPENCLAW_REPO_DIR;
  if (!hostDataDir || !hostRepoDir) {
    throw new Error(
      "MOSS_DATA_DIR and MOSS_OPENCLAW_REPO_DIR must be set in container env",
    );
  }
  // Longest prefix first — HOST_DATA_DIR and HOST_REPO_DIR may share a
  // common ancestor, but only HOST_DATA_DIR maps to a read/write container
  // mount; HOST_REPO_DIR is read-only at /app/src and the inner repo root
  // itself is not mounted.
  if (hostPath === hostDataDir || hostPath.startsWith(hostDataDir + "/")) {
    return CONTAINER_DATA_PREFIX + hostPath.slice(hostDataDir.length);
  }
  if (hostPath === hostRepoDir || hostPath.startsWith(hostRepoDir + "/")) {
    return CONTAINER_REPO_PREFIX + hostPath.slice(hostRepoDir.length);
  }
  // benchmark/ lives at <moss-root>/benchmark on host; mounted at
  // /benchmark in container (mirror of pathToHost's benchmark branch).
  const evoclawRoot = hostRepoDir.replace(/\/openclaw\/?$/, "");
  const benchmarkHostPrefix = `${evoclawRoot}/benchmark`;
  if (hostPath === benchmarkHostPrefix || hostPath.startsWith(benchmarkHostPrefix + "/")) {
    return CONTAINER_BENCHMARK_PREFIX + hostPath.slice(benchmarkHostPrefix.length);
  }
  return hostPath;
}

export function expandHomePath(p: string): string {
  if (p.startsWith("~/")) {
    return CONTAINER_DATA_PREFIX + p.slice(1);
  }
  if (p === "~") {
    return CONTAINER_DATA_PREFIX;
  }
  return p;
}

/** Generate the `_path_tree.md` content shown to every spawned role so they
 *  resolve `~/.openclaw/...` references using the host-absolute paths the host
 *  daemon understands. Read at boot; written into each `iteration_<N>/` so
 *  add_dirs include it. */
export function renderPathTreeMd(): string {
  const hostDataDir = process.env.MOSS_DATA_DIR ?? "<MOSS_DATA_DIR unset>";
  const hostRepoDir = process.env.MOSS_OPENCLAW_REPO_DIR ?? "<MOSS_OPENCLAW_REPO_DIR unset>";
  return `# Path tree (auto-generated at moss boot)

Use this table when interpreting any path mentioned in the system prompt or
in another role's markdown output. The container interior sees logical paths;
the host daemon (which executes file ops on your behalf) needs the host-abs
form. The two are interchangeable for read-only references.

| logical (container view) | host abs |
|---|---|
| ~/.openclaw/evo-loop-state/current/ | ${hostDataDir}/evo-loop-state/current/ |
| ~/.openclaw/evo-loop-state/current/iteration_<N>/ | ${hostDataDir}/evo-loop-state/current/iteration_<N>/ |
| ~/.openclaw/evo-loop-state/current/session-traces/ | ${hostDataDir}/evo-loop-state/current/session-traces/ |
| src/ | ${hostRepoDir}/src/ |
| src/evolution/ | ${hostRepoDir}/src/evolution/ |
| src/evolution/architecture-map.md | ${hostRepoDir}/src/evolution/architecture-map.md |
`;
}
