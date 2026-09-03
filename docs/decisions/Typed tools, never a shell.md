---
title: Typed tools, never a shell
tags: [decision]
---
# Typed tools, never a shell

The answer agent gets `search_memory`, `read_memory`, and `read_email` over an explicit allowlist (symlinks
and traversal rejected), never a shell, never a mutating tool, and an explicit navigation order (concepts
first for projects and interests, profiles for people, loops for pending items). Email text is untrusted;
instructions inside it are never followed.
