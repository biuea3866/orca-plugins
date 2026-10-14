"""Run the original native CLI on its original terminal through the shared gateway."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tomllib
from .gateway import Gateway
from .storage import router_home


def merge_config(target, patch):
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merge_config(target[key], value)
        else:
            target[key] = value


def codex_settings(env, argv=None):
    root = Path(env.get('CODEX_HOME', str(Path.home() / '.codex')))
    try:
        config = tomllib.loads((root / 'config.toml').read_text())
    except (OSError, ValueError):
        config = {}
    argv = list(argv or [])
    profile = None
    overrides = []
    for index, arg in enumerate(argv):
        if arg == '--':
            break
        if arg in ('-p', '--profile') and index + 1 < len(argv):
            profile = argv[index + 1]
        elif arg.startswith('--profile='):
            profile = arg.split('=', 1)[1]
        elif arg in ('-c', '--config') and index + 1 < len(argv):
            overrides.append(argv[index + 1])
        elif arg.startswith('--config='):
            overrides.append(arg.split('=', 1)[1])
    if profile:
        merge_config(config, config.get('profiles', {}).get(profile, {}))
    for override in overrides:
        try:
            merge_config(config, tomllib.loads(override))
        except ValueError:
            pass  # The native CLI reports malformed config using its own parser.
    provider = config.get('model_provider', 'openai')
    info = dict(config.get('model_providers', {}).get(provider, {}))
    if provider == 'openai':
        info.setdefault('name', 'OpenAI')
        info.setdefault('requires_openai_auth', True)
    upstream = info.get('base_url') or config.get('openai_base_url') or env.get('OPENAI_BASE_URL')
    if not upstream:
        api_key_mode = bool(env.get('OPENAI_API_KEY'))
        try:
            auth = json.loads((root / 'auth.json').read_text())
            api_key_mode = auth.get('auth_mode') == 'apikey' or api_key_mode
        except (OSError, ValueError):
            pass
        upstream = 'https://api.openai.com/v1' if api_key_mode else 'https://chatgpt.com/backend-api/codex'
    info.update(wire_api='responses', supports_websockets=False)
    info['_provider_id'] = provider
    return upstream, info


def toml_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, dict):
        return '{' + ', '.join(json.dumps(k) + '=' + toml_value(v) for k, v in value.items()) + '}'
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(v) for v in value) + ']'
    return json.dumps(value)


def launch_spec(agent, binary, argv, endpoint, env=None, info=None):
    env = dict(env or os.environ)
    command = [binary, *argv]
    if agent == 'claude':
        env['ANTHROPIC_BASE_URL'] = endpoint
        # Saved subscription auth, tool permission settings and CLI UI are retained.
    else:
        info = dict(info or codex_settings(env)[1], base_url=endpoint)
        provider = info.pop('_provider_id', 'openai')
        if provider != 'openai':
            # Keep custom authentication in its existing config, out of process argv.
            command += ['-c', f'model_providers.{provider}.base_url=' + toml_value(endpoint),
                        '-c', f'model_providers.{provider}.supports_websockets=false']
        else:
            # The built-in provider cannot override WebSocket capability.
            # Clone only public capability flags; retain cached OpenAI login.
            public = {key: info[key] for key in ('name', 'wire_api', 'requires_openai_auth',
                                               'supports_websockets', 'base_url') if key in info}
            command += ['-c', 'model_provider="llm-router"',
                        '-c', 'model_providers.llm-router=' + toml_value(public)]
        command += ['-c', 'features.enable_request_compression=false']
    env['LLM_ROUTER_ENDPOINT'] = endpoint
    env['LLM_ROUTER_AGENT'] = agent
    return command, env


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    agent = args.pop(0) if args else None
    if agent not in ('claude', 'codex'):
        raise ValueError('native launcher에는 claude 또는 codex가 필요합니다')
    config = json.loads((router_home() / 'native.json').read_text())
    binary = config[agent]
    first = args[0] if args else ''
    if os.environ.get('LLM_ROUTER_BYPASS') == '1' or any(flag in args for flag in ('--help', '-h', '--version', '-V')) or first in ('login', 'logout', 'update', 'mcp', 'plugin', 'completion', 'doctor', 'auth'):
        os.execv(binary, [binary, *args])
    env = dict(os.environ)
    if agent == 'codex':
        upstream, info = codex_settings(env, args)
    else:
        upstream, info = env.get('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'), None
        # Children may inherit a parent's gateway. Connect to the original upstream.
        upstream = env.get('LLM_ROUTER_ANTHROPIC_UPSTREAM', upstream)
        env['LLM_ROUTER_ANTHROPIC_UPSTREAM'] = upstream
    target_cwd = os.getcwd()
    if agent == 'codex':
        for index, arg in enumerate(args):
            if arg in ('-C', '--cd') and index + 1 < len(args):
                target_cwd = str(Path(args[index + 1]).resolve())
            elif arg.startswith('--cd='):
                target_cwd = str(Path(arg.split('=', 1)[1]).resolve())
    with_gateway = Gateway(agent, upstream, cwd=target_cwd).start()
    command, env = launch_spec(agent, binary, args, with_gateway.url, env, info)
    child = None
    old_handlers = {}
    try:
        child = subprocess.Popen(command, env=env)
        def forward(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)
        for sig in (signal.SIGTERM, signal.SIGHUP):
            old_handlers[sig] = signal.signal(sig, forward)
        # SIGINT is already delivered by the terminal to the entire foreground group.
        old_handlers[signal.SIGINT] = signal.signal(signal.SIGINT, lambda *_: None)
        code = child.wait()
        return code if code >= 0 else 128 - code
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        with_gateway.close()
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    raise SystemExit(main())
