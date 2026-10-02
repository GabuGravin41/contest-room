// A short sample paper used in practice mode (demos, rehearsals, load tests), so the real paper is never
// exposed before the contest. Admins can switch practice mode to the real paper on the admin page.
export const SAMPLE_PAPER = {
  id: 'sample',
  title: 'Sample paper (practice)',
  round: 'Practice round',
  instructions: [
    'This is a <b>practice paper</b> for trying out The Contest Room. It is not the real contest paper.',
    'Answers save automatically. You can move between problems and change answers at any time before you submit.',
    'Stay on this page. Leaving it, switching tabs, and pasting text from elsewhere are recorded, just as in the real contest.',
  ],
  sections: [
    {
      id: 'A', title: 'Multiple Choice', marksNote: '2 problems, 2 marks each',
      problems: [
        { id: '1', marks: 2, type: 'mcq', text: 'A shop sells pencils at 3 for 20 shillings. How much do 12 pencils cost?', options: ['60 shillings', '72 shillings', '80 shillings', '84 shillings', '90 shillings'] },
        { id: '2', marks: 2, type: 'mcq', text: 'How many whole numbers from 1 to 100 are divisible by 3 or by 5?', options: ['33', '41', '47', '50', '53'] },
      ],
    },
    {
      id: 'B', title: 'Written Answers', marksNote: '1 problem, 4 marks',
      problems: [
        { id: '3', marks: 4, type: 'written', text: 'A staircase has 6 steps. You climb it taking either 1 or 2 steps at a time.', parts: [
          { id: 'a', marks: 2, text: 'In how many different ways can you reach the top?' },
          { id: 'b', marks: 2, text: 'Explain how your method would work for a staircase of any number of steps.' },
        ] },
      ],
    },
    {
      id: 'C', title: 'Algorithm Design', marksNote: '1 problem, 6 marks',
      intro: 'Describe an algorithm in words or pseudocode. Explain why it is correct and state its running time.',
      problems: [
        { id: '4', marks: 6, type: 'algo', text: 'You are given a list of $n$ integers. Find the length of the longest block of consecutive positions whose values are all equal.',
          constraints: '$1 \\le n \\le 2 \\cdot 10^5$.', example: 'For $[4,4,1,1,1,4]$ the answer is 3.' },
      ],
    },
  ],
};
export const SAMPLE_KEY = { 1: 'C', 2: 'C' };
export const SAMPLE_POINTS = { 1: 2, 2: 2 };
