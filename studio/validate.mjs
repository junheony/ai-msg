#!/usr/bin/env node
// 읽기 전용 검사: 참조 파일·게임 저장소·승인 기록을 변경하지 않는다.
import { existsSync, globSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ladder = ['concept', 'assets', 'build', 'test', 'preview', 'approval', 'release'];
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && v.trim().length > 0;
const homePath = (v) => v.startsWith('~/') ? path.join(homedir(), v.slice(2)) : v;
const errors = [];
let paths = 0;
let globs = 0;
let matches = 0;

function validate(file) {
  const fail = (message) => errors.push(`${path.basename(file)}: ${message}`);
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { fail(`JSON 읽기 실패 (${error.message})`); return; }
  if (!object(data)) { fail('최상위 값은 객체여야 합니다.'); return; }
  const checkPath = (value, field, allowGlob = false) => {
    if (!string(value)) { fail(`${field}: 경로 문자열이 필요합니다.`); return; }
    if (!value.startsWith('~/') && !path.isAbsolute(value)) {
      fail(`${field}: ~/ 또는 절대 경로를 사용하세요.`); return;
    }
    const expanded = homePath(value);
    if (/[*?\[\]{}]/.test(value)) {
      if (!allowGlob) { fail(`${field}: glob을 사용할 수 없습니다.`); return; }
      try {
        const found = globSync(expanded);
        globs += 1;
        matches += found.length;
        if (!found.length) fail(`${field}: glob 일치 없음 (${value})`);
      } catch (error) { fail(`${field}: glob 검사 실패 (${error.message})`); }
    } else {
      paths += 1;
      if (!existsSync(expanded)) fail(`${field}: 경로 없음 (${value})`);
    }
  };
  const array = (value, field, each) => {
    if (!Array.isArray(value)) { fail(`${field}: 배열이 필요합니다.`); return; }
    value.forEach((item, index) => each(item, `${field}[${index}]`));
  };
  if (!string(data.id) || !slug.test(data.id)) fail('id: 소문자 slug가 필요합니다.');
  if (data.id !== path.basename(file, '.json')) fail('id와 파일명이 다릅니다.');
  if (!string(data.title)) fail('title: 이름이 필요합니다.');
  if (data.schema !== undefined && data.schema !== 1) fail('schema: 지원 버전은 1입니다.');
  for (const key of ['titleKo', 'genre', 'engine']) {
    if (data[key] !== undefined && !string(data[key])) fail(`${key}: 문자열이 필요합니다.`);
  }
  if (data.status !== undefined && !['live', 'candidate', 'building', 'concept', 'paused'].includes(data.status)) fail('status: 지원하지 않는 상태입니다.');
  if (data.reference !== undefined && data.reference !== null && (!string(data.reference) || !slug.test(data.reference) || data.reference === data.id)) fail('reference: 다른 게임의 slug 또는 null이어야 합니다.');
  if (data.cover !== undefined) checkPath(data.cover, 'cover');
  if (data.repos !== undefined) array(data.repos, 'repos', (repo, field) => {
    if (!object(repo)) { fail(`${field}: 객체가 필요합니다.`); return; }
    if (!string(repo.label)) fail(`${field}.label: 이름이 필요합니다.`);
    checkPath(repo.path, `${field}.path`);
    if (repo.readonly !== undefined && typeof repo.readonly !== 'boolean') fail(`${field}.readonly: 불리언이 필요합니다.`);
    for (const key of ['branch', 'remote']) if (repo[key] !== undefined && !string(repo[key])) fail(`${field}.${key}: 문자열이 필요합니다.`);
  });
  let lastStage = -1;
  array(data.stages, 'stages', (stage, field) => {
    if (!object(stage)) { fail(`${field}: 객체가 필요합니다.`); return; }
    const rank = ladder.indexOf(stage.id);
    if (rank < 0 || rank <= lastStage) fail(`${field}.id: 표준 단계 순서·중복을 확인하세요.`);
    lastStage = Math.max(lastStage, rank);
    if ('state' in stage) fail(`${field}.state: 단계 상태는 서버가 계산합니다.`);
    if (stage.evidence !== undefined) array(stage.evidence, `${field}.evidence`, (value, f) => checkPath(value, f, true));
  });
  if (data.artifacts !== undefined) {
    if (!object(data.artifacts)) fail('artifacts: 객체가 필요합니다.');
    else for (const kind of ['screenshots', 'concept', 'builds', 'video']) {
      if (data.artifacts[kind] !== undefined) array(data.artifacts[kind], `artifacts.${kind}`, (value, f) => checkPath(value, f, true));
    }
  }
  if (data.tests !== undefined) array(data.tests, 'tests', (test, field) => {
    if (!object(test)) { fail(`${field}: 객체가 필요합니다.`); return; }
    if (!string(test.label)) fail(`${field}.label: 이름이 필요합니다.`);
    checkPath(test.path, `${field}.path`);
  });
  if (data.preview !== undefined) array(data.preview, 'preview', (preview, field) => {
    if (!object(preview)) { fail(`${field}: 객체가 필요합니다.`); return; }
    if (!string(preview.label)) fail(`${field}.label: 이름이 필요합니다.`);
    try {
      const url = new URL(preview.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { fail(`${field}.url: 인증 정보 없는 HTTP(S) URL이 필요합니다.`); }
  });
  if (data.jobs !== undefined) array(data.jobs, 'jobs', (job, field) => {
    if (!string(job) || !slug.test(job)) { fail(`${field}: 작업 이름 slug가 필요합니다.`); return; }
    checkPath(`~/jobs/${job}`, field);
  });
  if (data.approvals !== undefined) array(data.approvals, 'approvals', (approval, field) => {
    if (!object(approval)) { fail(`${field}: 객체가 필요합니다.`); return; }
    if (!string(approval.what)) fail(`${field}.what: 승인 대상이 필요합니다.`);
    if (!['pending', 'approved', 'rejected'].includes(approval.state)) fail(`${field}.state: 잘못된 승인 상태입니다.`);
    if (approval.at !== undefined && approval.at !== null && (!string(approval.at) || !Number.isFinite(Date.parse(approval.at)))) fail(`${field}.at: 날짜 문자열 또는 null이어야 합니다.`);
  });
  if (data.nextAction !== undefined) {
    if (!object(data.nextAction)) fail('nextAction: 객체가 필요합니다.');
    else {
      if (!string(data.nextAction.text) || [...data.nextAction.text].length > 60 || !/[가-힣]/.test(data.nextAction.text)) fail('nextAction.text: 한국어를 포함한 60자 이하 문장이 필요합니다.');
      if (data.nextAction.owner !== undefined && typeof data.nextAction.owner !== 'boolean') fail('nextAction.owner: 불리언이 필요합니다.');
    }
  }
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('사용법: node studio/validate.mjs [JSON 파일 또는 폴더 ...]\n기본: studio/games/*.json. Node.js 22.17 이상. 구조·경로·glob 존재를 읽기 전용으로 검사합니다.');
} else {
  const inputs = args.length ? args : [fileURLToPath(new URL('./games', import.meta.url))];
  const files = [];
  for (const input of inputs) {
    const target = path.resolve(homePath(input));
    try {
      if (statSync(target).isDirectory()) files.push(...readdirSync(target).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(target, name)));
      else files.push(target);
    } catch (error) { errors.push(`${input}: 읽기 실패 (${error.message})`); }
  }
  if (!files.length) errors.push('검사할 매니페스트가 없습니다.');
  [...new Set(files)].forEach(validate);
  if (errors.length) {
    errors.forEach((error) => console.error(`실패: ${error}`));
    process.exitCode = 1;
  } else console.log(`통과: 매니페스트 ${new Set(files).size}개 · 일반 경로 ${paths}개 · glob ${globs}개 (${matches}개 일치). 승인·테스트 성공·출시 여부는 검사하지 않습니다.`);
}
