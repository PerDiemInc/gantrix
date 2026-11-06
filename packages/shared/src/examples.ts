/** Example projects, the same in the CLI (gantrix example <name>) and the dashboard. */
export interface ExampleProject {
  title: string;
  goal: string;
  /** Agents the plan relies on (gantrix team add installs them). */
  agents: string[];
  /** Questions wait for you, so examples get a longer time budget. */
  maxMinutes: number;
}

export const EXAMPLES: Record<string, ExampleProject> = {
  website: {
    title: 'Build me a website',
    goal: 'Build me a website. 1) cpo: ask me what the website is for, who it is for and which pages it needs, then write product/brief.md. 2) designer: sketch three different design styles from the brief as design/styles/*.html and ask me which one to build, then write design/chosen.md. 3) engineer: build the site in site/ in the chosen style and deploy it with deploy_site, then give me the link.',
    agents: ['cpo', 'designer', 'engineer'],
    maxMinutes: 180,
  },
};
