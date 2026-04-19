import type { Schema, Struct } from '@strapi/strapi';

export interface ContentActionStep extends Struct.ComponentSchema {
  collectionName: 'components_content_action_steps';
  info: {
    description: 'A concrete step the reader can take. Repeatable; the post renders these as a numbered plan at the end of the summary.';
    displayName: 'Action step';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 600;
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 120;
      }>;
  };
}

export interface ContentSection extends Struct.ComponentSchema {
  collectionName: 'components_content_sections';
  info: {
    description: 'A content section. `timeSec` is optional \u2014 populated for video posts (clickable seek), omitted for articles/blogs.';
    displayName: 'Section';
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 2000;
      }>;
    heading: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    timeSec: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
  };
}

export interface ContentTakeaway extends Struct.ComponentSchema {
  collectionName: 'components_content_takeaways';
  info: {
    description: 'A single key-takeaway bullet. Repeatable on posts (video summaries, future articles/blogs).';
    displayName: 'Takeaway';
  };
  attributes: {
    text: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 280;
      }>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'content.action-step': ContentActionStep;
      'content.section': ContentSection;
      'content.takeaway': ContentTakeaway;
    }
  }
}
