export type SystemStatus = 
  | 'BUILT_CERTIFIED'
  | 'BUILT_ADVANCED'
  | 'BUILT_CERTIFICATION_STAGE'
  | 'PLANNED'
  | 'PLANNED_IN_DEVELOPMENT'
  | 'ROADMAP_FUTURE';

export interface CosmosSystem {
  id: string;
  name: string;
  role: string;
  simpleMeaning: string;
  status: SystemStatus;
  statusLabel: string;
  summary: string;
  purpose: string[];
  capabilities: string[];
  contractInterface?: string;
  category: 'core' | 'specialized' | 'frontier' | 'governance';
  layer?: number;
}

export interface RequestFlowStep {
  id: number;
  stage: string;
  source: string;
  target: string;
  action: string;
  detail: string;
  payload: string;
  activeNodes: string[];
}

export interface ClaimNode {
  id: string;
  text: string;
  confidence: number;
  status: 'supported' | 'contradicted' | 'under_review';
  evidence: {
    id: string;
    title: string;
    source: string;
    type: 'empirical' | 'regulatory' | 'financial' | 'critical';
    contradicts?: boolean;
    quote: string;
    date: string;
  }[];
}
