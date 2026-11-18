// The starter agents every Gantrix installation begins with. The planner reads each
// description to decide who does what; people can edit them after.
/** The built-in executive team. The planner reads each description to decide who does what. */
export const TEAM = [
  {
    name: 'cto',
    avatar: 'preset:gant-glasses',
    skills: ['exec-cto'],
    description:
      'CTO: technology and engineering. Architecture decisions, code reviews, build plans and estimates, technical risks. Can run shell commands with approval.',
  },
  {
    name: 'cmo',
    avatar: 'preset:gant-headset',
    skills: ['exec-cmo'],
    description:
      'CMO: marketing. Positioning, messaging, campaign plans, launch posts, landing-page copy, SEO briefs and competitor comparisons.',
  },
  {
    name: 'cro',
    avatar: 'preset:gant-crown',
    skills: ['exec-cro'],
    description:
      'CRO: sales and revenue. Ideal-customer profiles, lead lists from public sources, personal cold email and SMS drafts, sends one-to-one email with approval.',
  },
  {
    name: 'ciso',
    avatar: 'preset:gant-shield',
    skills: ['exec-ciso'],
    description:
      "CISO: security. Threat models, code and dependency audits, config checks and authorized testing of the user's own systems, with a fix plan.",
  },
  {
    name: 'designer',
    avatar: 'preset:gant-beret',
    skills: ['exec-designer', 'google-slides'],
    description:
      'Designer: mobile apps, websites, dashboards, marketing materials (social posts, flyers, emails), business cards and slide decks in Google Slides. Briefs, wireframes, design tokens and HTML/CSS mockups, checked for accessibility.',
  },
  {
    name: 'engineer',
    avatar: 'preset:gant-night',
    skills: ['exec-engineer'],
    description:
      'Engineer: builds websites and small tools from the brief and the chosen design, tests them, and deploys websites to the local preview server.',
  },
  {
    name: 'cpo',
    avatar: 'preset:gant-antenna',
    skills: ['exec-cpo'],
    description:
      'CPO and project manager: product specs (PRDs), priorities, roadmaps, milestone timelines with owners and dates, risks and status updates. Keeps the team aligned.',
  },
  {
    name: 'devops',
    avatar: 'preset:gant-classic',
    skills: ['exec-devops'],
    description:
      'DevOps lead: deploys apps to the simplest platform that fits (Supabase, Heroku, Vercel, Netlify, Render, Fly.io, Railway, Cloudflare, GitHub Pages) and hands AWS and GCP Terraform work to aws-engineer and gcp-engineer.',
  },
  {
    name: 'aws-engineer',
    avatar: 'preset:gant-sunny',
    skills: ['devops-aws'],
    description:
      'AWS sub-agent for devops: Terraform for S3 + CloudFront, ECS Fargate, Lambda, RDS, IAM and VPCs; plans, checks and applies only when allowed.',
  },
  {
    name: 'gcp-engineer',
    avatar: 'preset:gant-mint',
    skills: ['devops-gcp'],
    description:
      'GCP sub-agent for devops: Terraform for Cloud Run, Cloud Storage + CDN, Cloud SQL, Artifact Registry and IAM; plans, checks and applies only when allowed.',
  },
] as const;

export type TeamRole = (typeof TEAM)[number]['name'];
