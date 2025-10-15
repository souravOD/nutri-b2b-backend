name: Bug report
description: Create a report to help us improve
title: "[Bug] "
labels: [bug]
body:
  - type: markdown
    attributes:
      value: "Thanks for taking the time to fill this out!"
  - type: input
    id: env
    attributes:
      label: Environment
      description: preview url or local
      placeholder: https://project-name-xxxxx.vercel.app
  - type: textarea
    id: desc
    attributes:
      label: What happened?
      description: Tell us what you saw and what you expected to see.
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Reproduction
      description: Steps or a minimal reproduction.
  - type: textarea
    id: logs
    attributes:
      label: Logs/Screenshots
