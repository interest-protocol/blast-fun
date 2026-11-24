import { PostSkeleton } from "../FeedSkeleton.tsx";
import { PostHeader } from "./PostHeader.tsx";
import postPage from "./PostPage.module.css";

export function PostLoading() {
  return (
    <div className={postPage.page} data-route-loading="post">
      <PostHeader />
      <PostSkeleton />
    </div>
  );
}
