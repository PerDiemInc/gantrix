/** Shown in the goal box: what a good OKR for a project looks like. */
export const OKR_EXAMPLE = `Objective: Launch a website that brings in catering orders for Crumb & Co.
Key results:
1. product/brief.md lists the audience, the 4 pages and the one action visitors should take
2. The chosen design is in design/chosen.md, picked by me from 3 styles
3. The site is live on the preview server with a working catering form
4. Every page passes the 4.5:1 contrast check`;

/** Example projects, the same in the CLI (gantrix example <name>) and the dashboard. */
export interface ExampleProject {
  title: string;
  /** What the project is, for the description box. */
  description: string;
  goal: string;
  /** Agents the plan relies on (gantrix team add installs them). */
  agents: string[];
  /** Questions wait for you, so examples get a longer time budget. */
  maxMinutes: number;
}

export const EXAMPLES: Record<string, ExampleProject> = {
  website: {
    title: 'Build me a website',
    description:
      'A simple website for my business. The team should ask me what it is for and who it is for, show me a few design directions, then build and publish it.',
    goal: 'Build me a website. 1) cpo: ask me what the website is for, who it is for and which pages it needs, then write product/brief.md. 2) designer: sketch three different design styles from the brief as design/styles/*.html and ask me which one to build, then write design/chosen.md. 3) engineer: build the site in site/ in the chosen style and deploy it with deploy_site, then give me the link.',
    agents: ['cpo', 'designer', 'engineer'],
    maxMinutes: 180,
  },
};
