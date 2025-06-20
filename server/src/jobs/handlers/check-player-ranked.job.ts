import { BadRequestError } from '../../api/errors';
import * as jagexService from '../../api/services/external/jagex.service';
import prisma from '../../prisma';
import { PlayerStatus } from '../../utils';
import { Job } from '../job.class';
import { JobOptions } from '../types/job-options.type';
import { JobType } from '../types/job-type.enum';

interface Payload {
  username: string;
}

export class CheckPlayerRankedJob extends Job<Payload> {
  static options: JobOptions = {
    rateLimiter: { max: 1, duration: 5_000 },
    attempts: 3,
    backoff: {
      type: 'exponential',
      // first attempt after 60 seconds, then 120, and then 240 (total: 7 minutes span)
      delay: 60_000
    }
  };

  async execute(payload: Payload) {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    // Since the hiscores are unstable, we can't assume that a 404 error from them is 100% accurate.
    // So, to make sure a player is no longer ranked on the hiscores, we need to make a few attempts,
    // and if all of them fail, then we can be pretty sure that the player is no longer ranked.

    // To avoid false positives due to a hiscores outage, this job has a exponential backoff strategy,
    // meaning that it will retry a few times, with a longer delay between each attempt.

    // Try to fetch stats for this player, let it throw an error if it fails.
    await jagexService.fetchHiscoresData(payload.username);
  }

  async onFailedAllAttempts(payload: Payload, error: Error) {
    // If it fails every attempt with the "Failed to load hiscores" (400) error message,
    // then we can be pretty sure that the player is unranked.
    if (!(error instanceof BadRequestError) || !error.message.includes('Failed to load hiscores')) return;

    await prisma.player.update({
      where: { username: payload.username },
      data: { status: PlayerStatus.UNRANKED }
    });

    // Being unranked could also mean a player is banned, so if we determine
    // that they're not on the hiscores, check if they're banned on RuneMetrics.
    this.jobManager.add(JobType.CHECK_PLAYER_BANNED, { username: payload.username });
  }
}
