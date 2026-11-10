import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const THEMES = ['dark', 'light'] as const;
const ACCENT_COLORS = ['violet', 'blue', 'teal', 'green', 'orange', 'rose'] as const;

export type AppearancePreferences = {
  theme: (typeof THEMES)[number];
  accentColor: (typeof ACCENT_COLORS)[number];
};

const DEFAULT_PREFERENCES: AppearancePreferences = { theme: 'dark', accentColor: 'violet' };

@Injectable()
export class UserPreferencesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async getAppearance(userId: string): Promise<AppearancePreferences> {
    const result = await this.database.transaction({ userId }, (client) =>
      client.query<{ theme: string; accent_color: string }>(
        'SELECT theme, accent_color FROM user_appearance_preferences WHERE user_id = $1',
        [userId],
      ),
    );
    const row = result.rows[0];
    return row
      ? {
          theme: row.theme as AppearancePreferences['theme'],
          accentColor: row.accent_color as AppearancePreferences['accentColor'],
        }
      : DEFAULT_PREFERENCES;
  }

  async updateAppearance(
    userId: string,
    input: { theme?: unknown; accentColor?: unknown },
  ): Promise<AppearancePreferences> {
    if (input.theme !== undefined && !(THEMES as readonly unknown[]).includes(input.theme)) {
      throw new BadRequestException('Theme must be dark or light.');
    }
    if (
      input.accentColor !== undefined &&
      !(ACCENT_COLORS as readonly unknown[]).includes(input.accentColor)
    ) {
      throw new BadRequestException('Choose a supported accent color.');
    }

    const result = await this.database.transaction({ userId }, (client) =>
      client.query<{
        theme: AppearancePreferences['theme'];
        accent_color: AppearancePreferences['accentColor'];
      }>(
        `INSERT INTO user_appearance_preferences (user_id, theme, accent_color, updated_at)
         VALUES ($1, COALESCE($2, 'dark'), COALESCE($3, 'violet'), now())
         ON CONFLICT (user_id) DO UPDATE SET
           theme = COALESCE($2, user_appearance_preferences.theme),
           accent_color = COALESCE($3, user_appearance_preferences.accent_color),
           updated_at = now()
         RETURNING theme, accent_color`,
        [userId, input.theme ?? null, input.accentColor ?? null],
      ),
    );
    return { theme: result.rows[0].theme, accentColor: result.rows[0].accent_color };
  }
}
