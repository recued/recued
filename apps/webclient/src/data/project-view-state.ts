import type { ProjectAttentionScope } from '@recued/contracts';

/** Display choices only, held in this paired boot's memory. Record contents
 * and recipient addresses are always read again by their owners. */
export interface ProjectWorkViewState {
  query: string; draft: string; error: string;
  tasks: 'all' | 'open' | 'completed'; commitments: 'open' | 'all';
  loaded: { task: number; note: number; commitment: number };
  attention?: { scope: ProjectAttentionScope; loaded: number };
}
export interface ProjectViewState extends ProjectWorkViewState {
  identity: string; top: number; focus: string;
}
export interface ProjectViewMemory { value?: ProjectViewState }
