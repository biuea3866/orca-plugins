import test from 'node:test'
import assert from 'node:assert/strict'
import { localCliEnvironment } from '../server/lib/runs.mjs'

test('local CLI preserves login directories and PATH while excluding API credentials and routes', () => {
 const parent = {HOME:'/users/me',PATH:'/bin',CLAUDE_CONFIG_DIR:'/profiles/claude',CODEX_HOME:'/profiles/codex',CLAUDE_CODE_OAUTH_TOKEN:'saved-login',ANTHROPIC_API_KEY:'fake',ANTHROPIC_AUTH_TOKEN:'fake',ANTHROPIC_BASE_URL:'http://gateway',OPENAI_API_KEY:'fake',CODEX_API_KEY:'fake',OPENAI_BASE_URL:'http://gateway',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_USE_VERTEX:'1',CLAUDE_CODE_USE_FOUNDRY:'1'}
 const env=localCliEnvironment(parent,{FAKE_AGENT_ANSWER:'1',ANTHROPIC_API_KEY:'override-key'})
 for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])assert.equal(env[name],undefined,name)
 for(const name of ['HOME','PATH','CLAUDE_CONFIG_DIR','CODEX_HOME','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(env[name],parent[name])
 assert.equal(env.LLM_ROUTER_BYPASS,'1')
 assert.equal(env.FAKE_AGENT_ANSWER,'1')
 assert.equal(parent.ANTHROPIC_API_KEY,'fake','parent environment stays unchanged')
})
