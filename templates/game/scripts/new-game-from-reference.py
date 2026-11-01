#!/usr/bin/env python3
"""레퍼런스를 읽어 새 게임만 생성한다. 설치·커밋·공개는 하지 않는다."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

LIMIT = 50 * 1024 * 1024
EXCLUDED_DIRS = {
    '.git', '.github', '.gitlab', '.circleci', '.husky', '.svn', '.hg',
    'node_modules', 'bower_components', 'vendor', '.venv', 'venv', '__pycache__',
    'dist', 'build', 'builds', 'release', 'releases', 'out', 'outputs', 'coverage',
    '.next', '.nuxt', '.cache', '.turbo', '.vercel', '.netlify', '.firebase',
    'library', 'temp', 'obj', 'logs', 'shots', 'screenshots', 'playtest',
    'test-results', 'playwright-report', '.aws', '.ssh', '.azure', '.gcloud',
    'secrets', 'credentials', '.terraform', '.codex', '.agents',
    'backup', 'backups', 'production', 'deploy', 'deployment', 'deployments',
}
EXCLUDED_FILES = {
    '.git', '.gitmodules', '.gitconfig',
    '.gitlab-ci.yml', '.gitlab-ci.yaml', 'jenkinsfile', 'azure-pipelines.yml',
    'vercel.json', 'netlify.toml', 'firebase.json', '.firebaserc', 'wrangler.toml',
    'wrangler.json', 'wrangler.jsonc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc',
    '.netrc', '.git-credentials', 'deployment.md', 'report.md', 'codex-progress.md',
    'approval.md', 'approvals.md', 'studio.json', 'docker-compose.yml',
}
SECRET_NAME = re.compile(r'(^\.env($|\.)|secret|credential|(^|[._-])(token|password|passwd|private[-_]?key)([._-]|$)|^id_(rsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks|tfstate)$)', re.I)
SECRET_DATA = re.compile(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}')
SLUG = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def safe_path(raw):
    supplied = Path(os.path.expanduser(str(raw)))
    if not supplied.is_absolute():
        supplied = Path.cwd() / supplied
    for component in [supplied, *supplied.parents]:
        if component.is_symlink():
            raise ValueError(f'심볼릭 링크 경로는 허용하지 않음: {component}')
    return Path(os.path.abspath(supplied))


def within(child, parent):
    return child == parent or parent in child.parents


def excluded(name, directory=False):
    low = name.lower()
    if SECRET_NAME.search(name):
        return True
    if directory:
        return low in EXCLUDED_DIRS or low.startswith('qa-')
    return low in EXCLUDED_FILES or low.endswith(('.log', '.tsbuildinfo'))


def collect(source):
    files, skipped = [], 0
    for root, dirs, names in os.walk(source, followlinks=False):
        parent = Path(root)
        keep = []
        for name in dirs:
            if (parent / name).is_symlink() or excluded(name, True):
                skipped += 1
            else:
                keep.append(name)
        dirs[:] = keep
        for name in names:
            file = parent / name
            mode = file.lstat()
            if not stat.S_ISREG(mode.st_mode) or excluded(name) or mode.st_size > LIMIT:
                skipped += 1
                continue
            # 알려진 자격증명은 파일 이름과 무관하게 제외한다. 완전한 비밀 탐지기는 아니다.
            if SECRET_DATA.search(file.read_bytes()):
                skipped += 1
                continue
            files.append(file.relative_to(source))
    return files, skipped


def clean_package(file):
    if not file.exists():
        return
    package = json.loads(file.read_text())
    package['private'] = True
    for field in ('publishConfig', 'repository', 'homepage', 'bugs'):
        package.pop(field, None)
    scripts = package.get('scripts', {})
    package['scripts'] = {k: v for k, v in scripts.items() if not (
        re.search(r'deploy|publish|release', k, re.I)
        or k in {'preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare'}
        or re.search(r'\b(vercel|netlify|firebase|wrangler|gh-pages)\b|\bnpm\s+publish\b|\bgit\s+push\b', str(v), re.I)
    )}
    file.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description='레퍼런스를 새 디렉터리로 복제하고 빈 스튜디오 증거를 등록')
    parser.add_argument('--reference', required=True, help='레퍼런스 게임 ID')
    parser.add_argument('--source', required=True, help='읽기 전용 레퍼런스 디렉터리')
    parser.add_argument('--id', required=True, help='새 게임 ID (소문자 slug)')
    parser.add_argument('--title', help='새 게임 표시명')
    parser.add_argument('--target', help='새 디렉터리 (기본 ~/games/<id>)')
    parser.add_argument('--studio-root', help='studio/를 담는 대시보드 루트')
    parser.add_argument('--dry-run', action='store_true', help='읽기·검증·계획 출력만 수행')
    args = parser.parse_args()
    for label, value in [('id', args.id), ('reference', args.reference)]:
        if not SLUG.fullmatch(value) or len(value) > 80:
            raise ValueError(f'{label}: 영문 소문자·숫자·하이픈 slug 필요 (80자 이하)')
    if args.id == args.reference:
        raise ValueError('새 게임 ID는 레퍼런스 ID와 달라야 함')
    template = safe_path(Path(__file__).absolute().parents[1])
    source = safe_path(args.source)
    target = safe_path(args.target or Path.home() / 'games' / args.id)
    studio = safe_path(args.studio_root or template.parents[1])
    manifest = safe_path(studio / 'studio' / 'games' / f'{args.id}.json')
    if not source.is_dir() or not studio.is_dir():
        raise ValueError('source와 studio-root는 존재하는 디렉터리여야 함')
    if target.exists() or manifest.exists():
        raise ValueError('target 또는 게임 manifest가 이미 존재함: 덮어쓰기 금지')
    reference_manifest = safe_path(studio / 'studio' / 'games' / f'{args.reference}.json')
    if not reference_manifest.is_file():
        raise ValueError('레퍼런스 manifest가 없음: studio-root/studio/games/<reference>.json 필요')
    reference_data = json.loads(reference_manifest.read_text())
    if not isinstance(reference_data, dict) or reference_data.get('id') != args.reference:
        raise ValueError('레퍼런스 manifest ID가 일치하지 않음')
    if within(source, target) or within(target, source):
        raise ValueError('source와 target은 같거나 조상·자손 관계일 수 없음')
    if within(manifest, source) or within(manifest, target) or within(template, target):
        raise ValueError('manifest/template는 source·target 내부에 중첩할 수 없음')
    allowed = [safe_path(Path.home() / 'games'), safe_path(Path.home() / 'bbai-codex')]
    if target.name != args.id or not (target.parent in allowed or within(target, safe_path('/tmp'))):
        raise ValueError('target은 ~/games/<id>, ~/bbai-codex/<id> 또는 /tmp 아래의 <id> 디렉터리여야 함')
    files, skipped = collect(source)
    print(f'레퍼런스: {args.reference} ({source})\n새 게임: {args.id} ({target})\n매니페스트: {manifest}')
    print(f'복제 예정 {len(files)}개, 안전 제외 {skipped}개; 증거·승인 빈 값, 자동 배포 없음')
    if args.dry_run:
        print('DRY-RUN: 파일 생성·git init 없이 종료')
        return
    if shutil.which('git') is None:
        raise ValueError('git 실행파일 없음')
    created = False
    written_manifest = False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.mkdir()  # 존재 경합도 덮어쓰지 않는다.
        created = True
        for relative in files:
            original = source / relative
            safe_path(original)
            if not original.is_file() or original.stat().st_size > LIMIT:
                raise ValueError('복제 중 원본 파일 변경 감지')
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, dest)
            dest.chmod(original.stat().st_mode & 0o777)
        # 중첩 패키지도 자동 실행/배포 hook를 제거한다.
        for package in target.rglob('package.json'):
            clean_package(package)
        for item in template.rglob('*'):
            if item.is_symlink() or not item.is_file() or '__pycache__' in item.parts:
                continue
            relative = item.relative_to(template)
            dest = target / relative
            if dest.is_dir():
                raise ValueError(f'템플릿 경로 충돌: {relative}')
            dest.parent.mkdir(parents=True, exist_ok=True)
            # 원본 에셋 고지는 별도 보존한 뒤 미검토 표로 시작한다.
            if relative.as_posix() == 'assets/LICENSES.md' and dest.exists():
                preserved = target / 'assets' / 'REFERENCE-LICENSES.md'
                if preserved.exists():
                    raise ValueError('원본 라이선스 보존 경로 충돌')
                dest.rename(preserved)
            shutil.copyfile(item, dest)
        values = {'id': args.id, 'title': args.title or args.id, 'reference': args.reference, 'target': str(target)}
        data = json.loads((template / 'studio.json').read_text())
        def fill(value):
            if isinstance(value, dict): return {k: fill(v) for k, v in value.items()}
            if isinstance(value, list): return [fill(v) for v in value]
            if isinstance(value, str):
                for key, val in values.items(): value = value.replace('{{' + key + '}}', val)
            return value
        data = fill(data)
        (target / 'studio.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
        for filename in ('CONCEPT.md', 'BRIEF.build.md', 'BRIEF.qa.md', 'BRIEF.art.md'):
            file = target / filename
            file.write_text(fill(file.read_text()))
        with (target / '.gitignore').open('a') as ignore:
            ignore.write('\n# 새 게임: 비밀·의존성·생성물 제외\n.env*\n*.pem\n*.key\nnode_modules/\ndist/\nbuild/\nshots/\ntest-results/\n')
        # 환경의 GIT_DIR/GIT_WORK_TREE와 global init template를 상속하지 않는다.
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env.update({'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'})
        subprocess.run(['git', '-c', 'init.templateDir=', 'init', '--quiet', '--', str(target)], env=env, check=True)
        manifest.parent.mkdir(parents=True, exist_ok=True)
        with manifest.open('x') as stream:
            written_manifest = True
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print('생성 완료: 새 저장소 git init만 수행 (커밋·원격·푸시 없음)')
        print('다음: CONCEPT.md 작성 → assets/LICENSES.md 권리 검토 → 빌드/QA job 생성 → 로컬 미리보기 → 명시 오너 승인')
        print('레퍼런스 코드·에셋은 검토 전 사용 금지. 기존 배포 명령·인프라 파일도 실행 전 수동 검토 필요.')
    except BaseException:
        if written_manifest:
            manifest.unlink(missing_ok=True)
        if created:
            shutil.rmtree(target)
        raise


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'거부/실패: {error}', file=sys.stderr)
        sys.exit(1)
