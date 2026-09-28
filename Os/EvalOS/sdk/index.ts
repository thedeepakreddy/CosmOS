export interface EvalOSClientOptions {
  baseUrl: string;
}

export class EvalOSClient {
  constructor(private options: EvalOSClientOptions) {}

  async createSuite(suite: any) {
    const res = await fetch(`${this.options.baseUrl}/v1/suites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(suite)
    });
    if (!res.ok) throw new Error(`Failed to create suite: ${res.statusText}`);
    return res.json();
  }

  async getSuite(id: string) {
    const res = await fetch(`${this.options.baseUrl}/v1/suites/${id}`);
    if (!res.ok) throw new Error(`Failed to get suite: ${res.statusText}`);
    return res.json();
  }

  async createRun(run: any) {
    const res = await fetch(`${this.options.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(run)
    });
    if (!res.ok) throw new Error(`Failed to create run: ${res.statusText}`);
    return res.json();
  }

  async startRun(id: string) {
    const res = await fetch(`${this.options.baseUrl}/v1/runs/${id}/start`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(`Failed to start run: ${res.statusText}`);
    return res.json();
  }

  async getRunResults(id: string) {
    const res = await fetch(`${this.options.baseUrl}/v1/runs/${id}/scores`);
    if (!res.ok) throw new Error(`Failed to get run results: ${res.statusText}`);
    return res.json();
  }
}
