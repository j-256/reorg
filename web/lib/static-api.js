import { setRequestHandler } from './api.js';

const API_BASE = 'file:///reorg-static/';

export function installStaticApi(data, { resolvePlan, describeOp }) {
  setRequestHandler(async (method, requestPath, body) => {
    const url = new URL(requestPath, API_BASE);
    const path = url.pathname;

    if (method === 'GET' && path === '/api/tree') {
      return {
        scan: data.scan,
        plan: data.plan,
        view: data.view,
        gitignore: data.gitignore,
        undoScripts: data.undoScripts,
        static: true,
      };
    }

    if (method === 'GET' && path === '/api/triage') return data.triage;

    if (method === 'GET' && path === '/api/head') {
      const id = url.searchParams.get('path');
      if (id && Object.hasOwn(data.previews, id)) return data.previews[id];
      throw new Error('This preview was not embedded in the static page');
    }

    if (method === 'POST' && path === '/api/resolve') {
      const resolved = resolvePlan(data.scan, body.plan || {});
      return {
        ...resolved,
        script: resolved.ops.map(describeOp),
      };
    }

    if (method === 'POST' && path === '/api/apply') {
      throw new Error('A static planner cannot check or write to disk; export the plan and apply it with the CLI');
    }

    if (method === 'POST' && path === '/api/rescan') {
      throw new Error('A static planner cannot rescan the directory; generate a new page from the CLI');
    }

    throw new Error(`Unavailable in a static planner: ${method} ${path}`);
  });
}
