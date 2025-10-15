name: Feature request
description: Suggest an idea for this project
title: "[Feature] "
labels: [enhancement]
body:
  - type: textarea
    id: pitch
    attributes:
      label: Proposal
      description: What do you want to see and why?
      placeholder: Short pitch
    validations:
      required: true
  - type: textarea
    id: scope
    attributes:
      label: Scope
      description: What’s in/out of scope?
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance
      description: How we’ll know it’s done.
