import { Knex } from 'knex';

/**
 * Migration: Add group column to layer_styles table
 *
 * Layer styles are scoped by element group so that styles created for
 * text elements only appear for text elements, layout styles only for
 * layout elements, etc.  The group is set at creation time based on
 * the element the style was created from.
 */
export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('layer_styles', 'group');
  if (!hasColumn) {
    await knex.schema.alterTable('layer_styles', (table) => {
      table.string('group', 64).nullable();
      table.index('group');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('layer_styles', 'group');
  if (hasColumn) {
    await knex.schema.alterTable('layer_styles', (table) => {
      table.dropIndex('group');
      table.dropColumn('group');
    });
  }
}
