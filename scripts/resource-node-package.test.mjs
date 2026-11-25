import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { checkResourceNodeLock, collectResourceClosure } from './build-resource-node.mjs';
import { verifyInstall } from './verify-resource-node-install.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-resource-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof text === 'string' ? text : JSON.stringify(text));
  };
  return { root, write };
}

test('resource role follows imports from its emitted entry only and fails closed on unsupported imports', t => {
  const { root, write } = fixture(t);
  write('resource-node.js', "import './owned.js'; import('node:fs');");
  write('owned.js', "export { Router } from 'express'; const asset = new URL('./profile.dat', import.meta.url);");
  write('profile.dat', 'owned');
  write('index.js', "import 'sherpa-onnx-node';");
  const graph = collectResourceClosure(root, ts);
  assert.deepEqual(graph.files, ['owned.js', 'profile.dat', 'resource-node.js']);
  assert.deepEqual(Object.keys(graph.dependencies), ['express']);
  write('owned.js', 'import(selectedPackage);');
  assert.throws(() => collectResourceClosure(root, ts), /Non-literal/);
  write('owned.js', "import 'untracked-resource-dependency';");
  assert.throws(() => collectResourceClosure(root, ts), /not declared/);
  write('owned.js', "import './missing.js';");
  assert.throws(() => collectResourceClosure(root, ts), /Unshippable/);
});

test('committed resource resolution lock matches current role manifests', () => checkResourceNodeLock());

test('installed resource dependency validation rejects missing and unreferenced locked packages', t => {
  const { root, write } = fixture(t);
  const dependencies = { resourceExample: '1.0.0' };
  write('resource-node.json', { role: 'resources', workspaces: ['web'], dependencies });
  write('bun.lock', { packages: { resourceExample: ['resourceExample@1.0.0'],
    unusedExample: ['unusedExample@1.0.0'] } });
  write('packages/web/package.json', { name: '@varin/web', version: '1.0.0', dependencies });
  assert.throws(() => verifyInstall(root), /cannot resolve resourceExample/);
  write('node_modules/resourceExample/package.json', { name: 'resourceExample', version: '1.0.0' });
  assert.deepEqual(verifyInstall(root), { packages: 1, workspaces: 1 });
  write('node_modules/unusedExample/package.json', { name: 'unusedExample', version: '1.0.0' });
  assert.throws(() => verifyInstall(root), /outside the resource dependency closure/);
});
