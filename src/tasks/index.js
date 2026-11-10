// Wszystkie zadania (kolejność = kolejność w katalogu w aplikacji).
import './troubleshooting.js';
import './cluster.js';
import './networking.js';
import './workloads.js';
import './storage.js';

export { REGISTRY, DOMAINS, DOMAIN_PL, DOMAIN_SHORT, render, values, hostName, runSetup, runCheck, runCleanup } from './registry.js';
export { TaskCtx, TaskUnavailable, Grader } from './ctx.js';
