import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { requirePermission } from '../auth.js';
import { typeByKey, type LogbookSettings } from '../logbook-types.js';
import { TRAINING_OFF, TrainingOff, trainingNeeded, trainingState, type Skill } from '../training.js';
import { settingsInForce } from './settings.js';

// D-71: the skills for the settings picker, and the sign step's training line for the signed-in person.
export function trainingRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

  // Recruitment's skills (training_v1). Not linked or not reachable: the skill is typed in the settings instead.
  app.get('/api/training/skills', anyUser, async () => {
    if (!app.training) return { linked: false, skills: [] as Skill[], note: 'Recruitment is not linked: type the skill code and title.' };
    try {
      return { linked: true, skills: await app.training.skills(), note: '' };
    } catch (e) {
      if (!(e instanceof TrainingOff)) throw e;
      return { linked: false, skills: [] as Skill[], note: `${TRAINING_OFF} Type the skill code and title.` };
    }
  });

  // What signing an entry of this type asks of this person now (the settings in force decide; the server checks again).
  app.get<{ Querystring: { logbookType?: string } }>('/api/training/check', anyUser, async (req, reply) => {
    const type = String(req.query.logbookType ?? '');
    if (!typeByKey(type)) return reply.code(400).send({ error: 'invalid_request' });
    const s = await settingsInForce(sql, type);
    return trainingState(app.training, req.user!, trainingNeeded(s?.settings as LogbookSettings | undefined));
  });
}
