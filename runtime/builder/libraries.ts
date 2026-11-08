/**
 * Sprint 26: the managed libraries of a build request, resolved against the registry (exact id and
 * version, the request's language and profile, every dependency present), and the request's
 * cache key, which names each library with its source tree checksum.
 */
import {
  MANAGED_LIBRARIES,
  PROGRAM_LIMITS,
  managedLibrary,
  profileById,
  programPathIssue,
  sourceKey,
  type ManagedLibrary,
} from '@tbi-lab/domain';
import { RequestError, type BuildRequest } from './protocol.js';

/** The request's libraries, dependency order; RequestError(422) for anything the registry refuses. */
export function requestLibraries(request: BuildRequest): ManagedLibrary[] {
  const refs = request.libraries ?? [];
  const profile = profileById(request.profile);
  const libs = refs.map((r) => {
    const lib = managedLibrary(r.id, r.version);
    if (!lib || !profile || lib.language !== profile.language || !lib.profiles.includes(profile.id))
      throw new RequestError(422, 'unknown_library');
    return lib;
  });
  const ids = new Set(libs.map((l) => l.id));
  for (const l of libs)
    for (const d of l.dependencies) if (!ids.has(d)) throw new RequestError(422, 'unknown_library');
  // Dependencies first (registry order is stable), then by id.
  const order = (l: ManagedLibrary) => MANAGED_LIBRARIES.indexOf(l);
  return libs.sort((a, b) => order(a) - order(b));
}

/** The cache key of a request: its files and, when any, its libraries' exact trees. */
export function requestKey(request: BuildRequest): string {
  return sourceKey(
    request.profile,
    request.files,
    requestLibraries(request).map((l) => ({ id: l.id, version: l.version, tree: l.tree })),
  );
}

/**
 * The profile's file rules for a request (before anything is held or written): the entry file
 * first, every further file a valid relative path for the language, unique ignoring case, each
 * within the profile's per-file limit and all within the project limit. RequestError otherwise.
 */
export function checkRequestFiles(request: BuildRequest): void {
  const profile = profileById(request.profile);
  if (!profile) throw new RequestError(400, 'unknown_profile');
  const [entry, ...rest] = request.files;
  if (!entry || entry.name !== profile.fileName) throw new RequestError(400, 'bad_file_name');
  if (request.files.length > PROGRAM_LIMITS.maxFiles) throw new RequestError(400, 'bad_files');
  const taken: string[] = [];
  for (const f of rest) {
    if (programPathIssue(profile.language, f.name, taken, profile.fileName))
      throw new RequestError(400, 'bad_file_name');
    taken.push(f.name);
  }
  let total = 0;
  for (const f of request.files) {
    const n = Buffer.byteLength(f.text, 'utf8');
    if (n > profile.maxSourceBytes) throw new RequestError(413, 'source_too_large');
    total += n;
  }
  if (total > PROGRAM_LIMITS.maxTotalBytes) throw new RequestError(413, 'source_too_large');
}
