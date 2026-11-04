import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'follow');

test('跟做扩展 MV3：manifest 合法且引用文件齐全、JS 可解析', () => {
  const manifestPath = join(root, 'manifest.json');
  assert.ok(existsSync(manifestPath));
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.ok(m.name);
  assert.equal(m.action?.default_popup, 'popup.html');
  assert.ok(m.permissions?.includes('storage'));
  assert.ok(m.background?.service_worker);
  assert.ok(Array.isArray(m.content_scripts) && m.content_scripts.length >= 1);

  const needed = new Set([
    m.action.default_popup,
    m.background.service_worker,
    ...m.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ]);
  // popup.html pulls popup.js
  const popupHtml = readFileSync(join(root, m.action.default_popup), 'utf8');
  const scriptRefs = [...popupHtml.matchAll(/src="([^"]+\.js)"/g)].map((x) => x[1]);
  for (const rel of scriptRefs) needed.add(rel);

  for (const rel of needed) {
    const p = join(root, rel);
    assert.ok(existsSync(p), `缺少扩展文件 ${rel}`);
  }

  for (const rel of [...needed].filter((f) => f.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', join(root, rel)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${rel} 语法错误: ${r.stderr}`);
  }

  const popupJs = readFileSync(join(root, 'popup.js'), 'utf8');
  const contentJs = readFileSync(join(root, 'content.js'), 'utf8');
  assert.match(popupJs, /\/api\/follow\//);
  assert.match(contentJs, /\/api\/follow\//);
  assert.match(contentJs, /sessionKey|session_key|k=/);
  assert.match(popupJs, /mode:\s*'run'|mode === 'run'/);
});
