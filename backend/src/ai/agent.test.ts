import { describe, expect, it } from 'vitest';
import { AGENT_PROMPT, AGENT_TOOLS, DESIGN_SYSTEM_PROMPT, agentSystemPrompt, cleanMessages } from './agent';

describe('agent design system', () => {
  it('declares view_reference and check_design', () => {
    const t = (n: string) => AGENT_TOOLS.find((x) => x.name === n)!;
    expect((t('view_reference').parameters as any).required).toEqual(['id']);
    expect(t('check_design')).toBeTruthy();
  });
  it('adds the design system section only when the context has a system', () => {
    const withSys = JSON.stringify({ brand: { name: 'B', designSystem: { summary: 'x' } } });
    const without = JSON.stringify({ brand: { name: 'B', designSystem: null } });
    expect(agentSystemPrompt(withSys)).toContain(DESIGN_SYSTEM_PROMPT);
    expect(agentSystemPrompt(without)).toBe(AGENT_PROMPT);
    expect(agentSystemPrompt('{}')).toBe(AGENT_PROMPT);
  });
  it('says how to scale, to pick a pattern, to check before finishing, and that the user wins', () => {
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/width \/ 1080/);
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/pattern/i);
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/check_design/);
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/user's request wins/i);
  });
  it('accepts calls to the new tools in a conversation', () => {
    const m = cleanMessages([{ role: 'user', text: 'hi' }, { role: 'assistant', calls: [{ id: 'a1', name: 'check_design', input: {} }, { id: 'a2', name: 'nope', input: {} }] }]);
    expect((m[1] as any).calls.map((c: any) => c.name)).toEqual(['check_design']);
  });
});
