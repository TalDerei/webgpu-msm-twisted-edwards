{{> structs }}
{{> bigint_funcs }}
{{> field_funcs }}
{{> ec_funcs }}
{{> montgomery_product_funcs }}

@group(0) @binding(0)
var<storage, read> points: array<Point>;
@group(0) @binding(1)
var<storage, read> scalar_chunks: array<u32>;
@group(0) @binding(2)
var<storage, read> new_point_indices: array<u32>;
@group(0) @binding(3)
var<storage, read> cluster_start_indices: array<u32>;
@group(0) @binding(4)
var<storage, read> num_new_points_per_row: array<u32>;
@group(0) @binding(5)
var<storage, read> row_last_end_idx: array<u32>;
@group(0) @binding(6)
var<storage, read_write> new_points: array<Point>;
@group(0) @binding(7)
var<storage, read_write> new_scalar_chunks: array<u32>;

@compute
@workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    /*new_points[global_id.x] = points[global_id.x];*/

    var gidx = global_id.x;

    var start_idx = cluster_start_indices[gidx];
    var end_idx = cluster_start_indices[gidx + 1u];

    // if global_id.x is at the last element of cluster_start_indices, set
    // end_idx to the same value as start_idx
    if (gidx >= (arrayLength(&cluster_start_indices))) {
        end_idx = cluster_start_indices[arrayLength(&new_point_indices) - 1u];
    }

    for (var i = 0u; i < arrayLength(&num_new_points_per_row); i ++) {
        if (gidx == num_new_points_per_row[i]) {
            end_idx = row_last_end_idx[i];
            break;
        }
    }

    var pt = points[new_point_indices[start_idx]];

    for (var i = start_idx + 1u; i < end_idx; i ++) {
          pt = add_points(pt, points[new_point_indices[i]]);
    }

    new_points[gidx] = pt;
    new_scalar_chunks[gidx] = scalar_chunks[new_point_indices[start_idx]];
}
