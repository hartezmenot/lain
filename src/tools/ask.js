'use strict';

/** ask_user — the model asks the human a question with concrete options. */

const MAX_OPTIONS = 12;

const tools = {
  ask_user: {
    mutates: false,
    schema: {
      name: 'ask_user',
      description:
        'Ask the user a question with a short list of options, when a genuine fork in the work '
        + 'needs their decision. Returns the option they chose. '
        + 'Ask early when two readings of the request would lead to materially different work: one '
        + 'question is cheaper than building the wrong thing. Ask only about what the user knows and '
        + 'the machine cannot find out: intent, preference, '
        + 'and which reading of their words is right. Never ask what a read, a search or a test run '
        + 'would answer. A few questions per task, then decide yourself and state the assumption. '
        + 'Do not write instructions about how to reply — no "(please type a number)", no '
        + '"reply with a letter". The interface draws the choices, numbers or letters them, and '
        + 'prints its own prompt describing exactly what it accepts; your version can only '
        + 'contradict it. Give the question and the options and nothing else.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'the question, in one sentence' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'the choices, for input "choice" or "multi". PLAIN STRINGS — put any '
              + 'reasoning in the same string after an em dash ("React — fast, big ecosystem"), '
              + 'not in a nested object. An "Other…" entry is added automatically to a choice '
              + 'list, so never write one yourself.',
          },
          input: {
            type: 'string',
            enum: ['choice', 'number', 'text', 'confirm', 'multi'],
            description:
              'WHAT KIND OF ANSWER this needs, so the interface can offer a surface that actually '
              + 'takes it: "choice" (default, one of options), "number" (a validated number — no '
              + 'options), "text" (free text — no options), "confirm" (yes or no), "multi" (any of '
              + 'options). Get this right rather than asking for a number in the question text: the '
              + 'interface prints its own accurate prompt from this field, and a mismatch means the '
              + 'user is told to type something the surface will not accept.',
          },
        },
        required: ['question'],
      },
    },
    async run(input, ctx) {
      const question = String((input && input.question) || '').trim();
      if (!question) return { output: 'ask_user needs a question', isError: true };
      // NORMALISED, NOT COERCED.
      const options = Array.isArray(input.options)
        ? input.options.map((o) => require('../ui/answer').optionText(o).replace(/\s+/g, ' ').trim())
          .filter(Boolean).slice(0, MAX_OPTIONS)
        : [];
      const asKind = input.input == null ? null : String(input.input);

      if (typeof ctx.ask !== 'function') {
        return {
          output: 'No interactive UI is available in this run, so the user cannot be asked. '
            + 'Decide using your best judgement and say which assumption you made.',
          isError: false,
        };
      }

      const answer = await ctx.ask({ question, options, input: asKind });
      if (answer == null || answer === '') {
        return { output: 'The user dismissed the question without answering. Continue with your best judgement.' };
      }

      return {
        output: `The user chose: ${answer}`,
        meta: { question, answer },
      };
    },
  },
};

module.exports = { tools, MAX_OPTIONS };
