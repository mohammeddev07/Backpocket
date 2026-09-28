import { onAccountChange } from '../ui/account';
import { initAiUi } from '../ui/aiUi';
import { initPlans } from '../ui/planView';
import { refreshAiAccess } from './access';
import { initEmbeddings } from './embeddings';
import { clearSemanticCache, initSemanticSearch } from './semantic';
import { initSortOnSave } from './sortOnSave';

/** Wires up sort-on-save, semantic search, embeddings, plans and AI settings. */
export function initAi(): void {
  initAiUi();
  initSortOnSave();
  initSemanticSearch();
  initEmbeddings();
  initPlans();
  onAccountChange((user) => {
    clearSemanticCache();
    void refreshAiAccess(user);
  });
}
