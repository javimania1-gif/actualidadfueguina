export function getAiProviderConfig(env = process.env) {
  return {
    provider: env.AF_AI_PROVIDER || 'github',
    model: env.AF_AI_MODEL || env.AF_MODEL || 'openai/gpt-4o-mini'
  };
}

export function extractJsonObject(value) {
  const raw = String(value || '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(unfenced); } catch {}
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(unfenced.slice(first, last + 1));
  throw new Error('La IA no devolvio JSON valido');
}

export async function callAiJson({ system, user, temperature = 0.35, env = process.env }) {
  const { provider, model } = getAiProviderConfig(env);
  if (provider !== 'github') {
    throw new Error(`AI_PROVIDER_UNSUPPORTED: ${provider}`);
  }

  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('Falta GITHUB_TOKEN');

  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GitHub Models HTTP ${response.status}: ${details.slice(0, 500)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  return extractJsonObject(content);
}
