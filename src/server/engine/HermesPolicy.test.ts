import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HERMES_BOOTSTRAP } from './HermesEngine';
const run = promisify(execFile);
const fixture = `
import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location('msg_bootstrap', sys.argv[1])
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
hermes = types.ModuleType('hermes_cli')
hermes.__version__ = sys.argv[2]
config = types.ModuleType('hermes_cli.config')
original = {'approvals': {'mode': 'off', 'deny': ['keep']}, 'hooks_auto_accept': True, 'model': 'original'}
config.load_config = lambda: original
config.load_config_readonly = lambda: original
loader = types.ModuleType('hermes_cli.env_loader')
def native_load(**kwargs):
    os.environ['HERMES_YOLO_MODE'] = '1'
    os.environ['HERMES_ACCEPT_HOOKS'] = '1'
    return []
loader.load_hermes_dotenv = native_load
entry = types.ModuleType('acp_adapter.entry')
entry._load_env = lambda: loader.load_hermes_dotenv()
acp = types.ModuleType('acp_adapter')
acp.entry = entry
approval = types.ModuleType('tools.approval')
approval._YOLO_MODE_FROZEN = True
approval._session_yolo = {'old'}
approval._get_approval_mode = lambda: config.load_config()['approvals']['mode']
approval.is_approval_bypass_active = lambda: approval._YOLO_MODE_FROZEN or bool(approval._session_yolo) or approval._get_approval_mode() != 'manual'
tools = types.ModuleType('tools')
tools.approval = approval
for name, mod in [('hermes_cli',hermes),('hermes_cli.config',config),('hermes_cli.env_loader',loader),('acp_adapter',acp),('acp_adapter.entry',entry),('tools',tools),('tools.approval',approval)]:
    sys.modules[name] = mod
try:
    bootstrap.install_policy()
except RuntimeError:
    print(json.dumps({'refused': True}))
    sys.exit(0)
loader.load_hermes_dotenv()
assert os.environ['HERMES_YOLO_MODE'] == '0'
assert os.environ['HERMES_ACCEPT_HOOKS'] == '0'
assert config.load_config()['approvals'] == {'mode': 'manual', 'deny': ['keep']}
assert config.load_config_readonly()['hooks_auto_accept'] is False
assert original['approvals']['mode'] == 'off'
assert original['hooks_auto_accept'] is True
assert not approval.is_approval_bypass_active()
try:
    approval.enable_session_yolo('new')
    raise AssertionError('native yolo enabled')
except RuntimeError:
    pass
print(json.dumps({'safe': True, 'nativeUnchanged': True}))
`;
describe('Hermes process-local policy bootstrap', () => {
  it('forces manual approvals after unsafe config and every dotenv reload without editing native config', async () => {
    const { stdout } = await run('python3', ['-B', '-I', '-c', fixture, HERMES_BOOTSTRAP, '0.18.2']);
    expect(JSON.parse(stdout)).toEqual({ safe: true, nativeUnchanged: true });
  });
  it('fails closed on an unreviewed Hermes version', async () => {
    const { stdout } = await run('python3', ['-B', '-I', '-c', fixture, HERMES_BOOTSTRAP, '0.19.0']);
    expect(JSON.parse(stdout)).toEqual({ refused: true });
  });
});
