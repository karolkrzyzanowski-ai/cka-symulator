// Świat symulacji: klaster + hosty + manifesty pod URL-ami.
import { createCluster, attachControllers } from './bootstrap.js';
import { Cluster } from './cluster.js';
import { Host } from './hosts.js';
import { manifestFor } from './manifests.js';
import { seedRandom } from '../lib/util.js';

export function newWorld(opts = {}) {
  const cluster = createCluster(opts);
  return { cluster, manifests: manifestFor };
}

export function worldFromJSON(json, seed = 777) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const cluster = attachControllers(Cluster.fromJSON(data, Host));
  seedRandom(seed);
  return { cluster, manifests: manifestFor };
}

export function snapshot(world) { return JSON.stringify(world.cluster); }
