// Shared fake conversation (shape of claude.ai's ?tree=True response).
//
//  H1 ─ A1 ┬ H2a ┬ A2a  ─ H3a "What about food?"
//          │     └ A2a2 ─ H3c                      (Retry on Claude's reply)
//          └ H2b ─ A2b  ─ H3b "What about food?" ─ A3b   (edit of message 2; server leaf)
const ROOT = '00000000-0000-4000-8000-000000000000';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = (m) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
const msg = (n, sender, parent, minute, text) => ({
  uuid: id(n), sender, parent_message_uuid: parent, created_at: t(minute),
  content: [{ type: 'text', text }], files: [],
});
const IDS = {
  H1: id(1), A1: id(2), H2a: id(3), H2b: id(4), A2a: id(5), A2a2: id(6),
  H3a: id(7), H3c: id(8), A2b: id(9), H3b: id(10), A3b: id(11),
};
const TEXT = {
  H1: 'Hello there, I want to plan a **trip** for next year',
  A1: 'Sure! Where would you like to go?',
  H2a: 'Japan in spring please',
  H2b: 'Korea in autumn instead',
  A2a: 'Japan in spring is lovely, sakura season peaks in early April.',
  A2a2: 'Spring in Japan means cherry blossoms; book hotels early.',
  H3a: 'What about food?',
  H3c: 'Budget for two weeks?',
  A2b: 'Korea in autumn has beautiful foliage around late October.',
  H3b: 'What about food?',
  A3b: 'Try bibimbap, tteokbokki and Korean BBQ.',
};
function conversation() {
  return {
    uuid: 'conv', name: 'Trip planning', updated_at: t(20),
    current_leaf_message_uuid: IDS.A3b,
    chat_messages: [
      msg(1, 'human', ROOT, 1, TEXT.H1),
      msg(2, 'assistant', IDS.H1, 2, TEXT.A1),
      msg(3, 'human', IDS.A1, 3, TEXT.H2a),
      msg(5, 'assistant', IDS.H2a, 4, TEXT.A2a),
      msg(7, 'human', IDS.A2a, 5, TEXT.H3a),
      msg(6, 'assistant', IDS.H2a, 6, TEXT.A2a2),
      msg(8, 'human', IDS.A2a2, 7, TEXT.H3c),
      msg(4, 'human', IDS.A1, 10, TEXT.H2b),
      msg(9, 'assistant', IDS.H2b, 11, TEXT.A2b),
      msg(10, 'human', IDS.A2b, 12, TEXT.H3b),
      msg(11, 'assistant', IDS.H3b, 13, TEXT.A3b),
    ],
  };
}
module.exports = { ROOT, IDS, TEXT, conversation };
