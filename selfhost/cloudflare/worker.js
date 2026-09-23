import { Container, getRandom } from '@cloudflare/containers';

/**
 * PRENIVDL on Cloudflare.
 *
 * The Worker itself only routes: yt-dlp is a Python binary and Workers cannot
 * spawn subprocesses, so the actual extraction runs in this container image
 * (see ./Dockerfile). Every request is forwarded to one of `max_instances`
 * container instances; idle containers sleep and scale back to zero.
 */
export class PrenivdlContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';

  // Values land inside the container as environment variables. Set the cookie
  // secret with:  npx wrangler secret put YTDLP_COOKIES_B64
  envVars = {
    PORT: '8080',
    YTDLP_BIN: 'yt-dlp',
    YTDLP_COOKIES_B64: this.env?.YTDLP_COOKIES_B64 ?? ''
  };

  onStart() {
    console.log('prenivdl container started');
  }

  onStop() {
    console.log('prenivdl container stopped');
  }

  onError(error) {
    console.error('prenivdl container error:', error);
  }
}

export default {
  async fetch(request, env) {
    // Stateless, interchangeable instances -> load balance across them.
    const container = await getRandom(env.PRENIVDL, 3);
    return container.fetch(request);
  }
};
