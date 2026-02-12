/**
 * Logger re-export.
 * 
 * All logging should use the structured logger from observabilityService.
 * This file exists so that `import logger from '../utils/logger'` still works.
 */
export { logger as default, logger } from '../services/observabilityService';
