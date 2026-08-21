export type WorkRecordStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type WorkRecordType =
  | "document"
  | "research"
  | "reminder"
  | "analysis"
  | "general";

export interface WorkRecordAttachment {
  name: string;
  kind: string;
  path?: string;
  size?: number;
}

export interface WorkRecordStep {
  id: string;
  name: string;
  label: string;
  status: "running" | "completed" | "failed";
  position: number;
  preview?: string;
}

export interface WorkRecordSnapshot {
  id: string;
  revision: number;
  profileId: string;
  profileName: string;
  sessionId?: string;
  title: string;
  type: WorkRecordType;
  status: WorkRecordStatus;
  prompt: string;
  resultSummary?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  attachments: WorkRecordAttachment[];
  steps: WorkRecordStep[];
}

export interface WorkRecordSummary {
  id: string;
  profileId: string;
  sessionId?: string;
  title: string;
  type: WorkRecordType;
  status: WorkRecordStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WorkRecordDetail extends WorkRecordSummary {
  profileName: string;
  prompt: string;
  resultSummary?: string;
  attachments: WorkRecordAttachment[];
  steps: WorkRecordStep[];
}

export interface WorkRecordQuery {
  profileId: string;
  title?: string;
  type?: WorkRecordType | "all";
  status?: WorkRecordStatus | "all";
  since?: number;
}
